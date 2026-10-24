import { and, eq, sql } from 'drizzle-orm'
import { UnrecoverableError } from 'bullmq'
import type { AppDeps } from '../app/types.js'
import { jobs, jobStages, projects } from '../db/schema/index.js'
import type { Log } from '../lib/log.js'
import { CancelledError } from '../media/ffmpeg.js'
import type { TranscriptionProvider } from '../transcription/types.js'
import { STEP_LABELS, type PipelineContext, type Stage } from './context.js'
import { GENERIC_FAILURE, PermanentError } from './errors.js'
import { Reporter } from './reporter.js'
import { audio } from './stages/audio.js'
import { indexStage } from './stages/index-stage.js'
import { probe } from './stages/probe.js'
import { ready } from './stages/ready.js'
import { scenesStage } from './stages/scenes.js'
import { splitProxy } from './stages/split-proxy.js'
import { timelineStage } from './stages/timeline.js'
import { transcribe } from './stages/transcribe.js'
import { WorkDir } from './workdir.js'

/**
 * The pipeline, in order. Each stage maps onto one of the Processing screen's five steps and owns a slice of
 * the 0-100 progress bar. Order matters: later stages read what earlier ones stored.
 */
export const STAGES: Stage[] = [
  probe,
  scenesStage,
  splitProxy,
  audio,
  transcribe,
  indexStage,
  timelineStage,
  ready,
]

export interface ProcessDeps {
  deps: AppDeps
  log: Log
  provider: TranscriptionProvider
}

export interface QueuedJob {
  data: { jobId: string }
  attemptsMade: number
  opts: { attempts?: number }
}

export type Outcome = 'done' | 'cancelled' | 'skipped'

/** How often to check that the project still exists, so deleting it stops the work. */
const WATCH_EVERY_MS = 3000

/**
 * Runs one project's processing job from wherever it last stopped.
 *
 * Every stage records its result in `job_stages` when it finishes, and stages are idempotent (each replaces
 * what an earlier try left). So a job that failed, was retried by the queue, or was retried by the user picks
 * up at the stage that failed, not at the start, and a worker crash costs at most one stage's work.
 */
export async function processProject(pd: ProcessDeps, queued: QueuedJob): Promise<Outcome> {
  const { deps, log } = pd
  const { db } = deps.database
  const jobId = queued.data.jobId

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  if (!job) return 'skipped'
  if (job.status === 'done') return 'skipped'
  const [project] = job.projectId
    ? await db.select().from(projects).where(eq(projects.id, job.projectId))
    : []
  if (!project) {
    log.info({ jobId }, 'project is gone; nothing to process')
    return 'cancelled'
  }

  const report = new Reporter(deps, job)
  report.seed(job.found)
  const controller = new AbortController()
  const work = WorkDir.create(deps.config.TMP_DIR, jobId)
  const watcher = setInterval(() => {
    db.select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id))
      .then((rows) => {
        if (!rows.length) controller.abort()
      })
      .catch(() => undefined)
  }, WATCH_EVERY_MS)

  const attempt = queued.attemptsMade + 1
  let currentStage: Stage | undefined

  try {
    await report.update(
      { status: 'running', attempts: attempt, error: null, errorCode: null },
      { force: true },
    )
    await db
      .update(projects)
      .set({ status: 'processing', error: null })
      .where(eq(projects.id, project.id))

    // One row per stage, created once. Existing rows (from earlier attempts) are what makes resuming work.
    await db
      .insert(jobStages)
      .values(STAGES.map((s) => ({ jobId, stage: s.key })))
      .onConflictDoNothing()
    const rows = await db.select().from(jobStages).where(eq(jobStages.jobId, jobId))
    const byKey = new Map(rows.map((r) => [r.stage, r]))

    const ctx: PipelineContext = {
      deps,
      log,
      provider: pd.provider,
      job,
      project,
      work,
      signal: controller.signal,
      report,
      prior: {},
      progress: () => undefined,
    }

    for (const stage of STAGES) {
      if (controller.signal.aborted) throw new CancelledError()
      const row = byKey.get(stage.key)!
      if (row.status === 'done') {
        ctx.prior[stage.key] = row.output
        // Resumed: show where the job already is.
        await report.update({
          progress: stage.to,
          step: stage.step,
          detail: STEP_LABELS[stage.step],
        })
        continue
      }

      currentStage = stage
      ctx.progress = (fraction) => {
        const f = Math.min(1, Math.max(0, fraction))
        void report
          .update({ progress: stage.from + (stage.to - stage.from) * f })
          .catch(() => undefined)
      }
      await db
        .update(jobStages)
        .set({
          status: 'running',
          attempts: sql`${jobStages.attempts} + 1`,
          startedAt: new Date(),
          error: null,
        })
        .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, stage.key)))
      await report.update(
        {
          step: stage.step,
          detail: STEP_LABELS[stage.step],
          stage: stage.key,
          progress: stage.from,
        },
        { force: true },
      )
      log.info({ jobId, stage: stage.key, attempt }, 'stage started')

      const started = Date.now()
      let output: Record<string, unknown>
      try {
        output = await stage.run(ctx)
      } catch (e) {
        await db
          .update(jobStages)
          .set({ status: 'failed', error: describe(e), finishedAt: new Date() })
          .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, stage.key)))
          .catch(() => undefined)
        throw e
      }

      await db
        .update(jobStages)
        .set({ status: 'done', output, finishedAt: new Date(), error: null })
        .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, stage.key)))
      ctx.prior[stage.key] = output
      log.info({ jobId, stage: stage.key, ms: Date.now() - started }, 'stage finished')
      if (stage !== ready) await report.update({ progress: stage.to }, { force: true })
    }
    return 'done'
  } catch (e) {
    // The project was deleted while we worked: stop quietly. Its rows (and this job) are already gone.
    if (e instanceof CancelledError || controller.signal.aborted) {
      log.info({ jobId }, 'processing cancelled: the project was deleted')
      return 'cancelled'
    }

    const permanent = e instanceof PermanentError
    const lastAttempt = attempt >= (queued.opts.attempts ?? 1)
    if (permanent || lastAttempt) {
      await markFailed(deps, report, project.id, currentStage, e)
      log.error({ err: e, jobId, stage: currentStage?.key }, 'processing failed')
      // Told to the queue as unrecoverable, so it does not retry what cannot work.
      if (permanent) throw new UnrecoverableError((e as Error).message)
      throw e
    }
    log.warn(
      { err: e, jobId, stage: currentStage?.key, attempt },
      'stage failed; the queue will retry',
    )
    throw e
  } finally {
    clearInterval(watcher)
    work.destroy()
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 2000) : String(e)
}

/**
 * Final failure: the Processing screen shows what the mock's failure state shows, with the same shape: status
 * `failed`, the step it stopped at, an `error` a person can read, and "<step> stopped" as the detail.
 */
async function markFailed(
  deps: AppDeps,
  report: Reporter,
  projectId: string,
  stage: Stage | undefined,
  error: unknown,
): Promise<void> {
  const permanent = error instanceof PermanentError
  const message = permanent ? error.message : GENERIC_FAILURE
  const step = stage?.step ?? 1
  await report
    .update(
      {
        status: 'failed',
        step,
        detail: `${STEP_LABELS[step]} stopped`,
        error: message,
        errorCode: permanent ? error.code : 'PROCESSING_FAILED',
      },
      { force: true },
    )
    .catch(() => undefined)
  await deps.database.db
    .update(projects)
    .set({ status: 'failed', error: message })
    .where(eq(projects.id, projectId))
    .catch(() => undefined)
}
