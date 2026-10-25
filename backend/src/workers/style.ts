import { eq } from 'drizzle-orm'
import { Worker, type Job as BullJob } from 'bullmq'
import { z } from 'zod'
import { jobs } from '../db/schema/index.js'
import { bullConnectionOptions, createRedis } from '../queue/connection.js'
import { QUEUES, type JobData } from '../queue/queues.js'
import { StyleAnalysis } from '../style/analysis/service.js'
import { InstagramSync } from '../style/jobs/sync.js'
import type { TranscriptionProvider } from '../transcription/types.js'
import type { WorkerContext } from './maintenance.js'

const analysisPayload = z.object({ reelIds: z.array(z.string()).optional() })
const deletionPayload = z.object({
  prefix: z.string(),
  uploads: z.array(z.object({ key: z.string(), uploadId: z.string() })).default([]),
})

async function mark(ctx: WorkerContext, id: string, patch: Partial<typeof jobs.$inferInsert>) {
  await ctx.deps.database.db.update(jobs).set(patch).where(eq(jobs.id, id))
}

/**
 * Runs one style job. Analysis is idempotent and picks up where it stopped, so a job the queue runs again after a crash
 * does only the Reels that are left. A Reel that cannot be measured is marked failed on its own row and does not fail the job;
 * only an outage (storage, speech recognition) does, and the queue retries that.
 */
export async function processStyleJob(
  ctx: WorkerContext,
  provider: TranscriptionProvider,
  bull: Pick<BullJob<JobData>, 'data' | 'attemptsMade'>,
): Promise<Record<string, unknown> | null> {
  const [row] = await ctx.deps.database.db.select().from(jobs).where(eq(jobs.id, bull.data.jobId))
  if (!row || row.status === 'done') return null
  // Deleting someone's style data has to work even after their account is gone; everything else belongs to a person.
  if (!row.userId && row.type !== 'style_deletion') return null

  await mark(ctx, row.id, {
    status: 'running',
    startedAt: new Date(),
    attempts: bull.attemptsMade + 1,
    error: null,
    errorCode: null,
  })

  let result: Record<string, unknown>
  switch (row.type) {
    case 'style_analysis': {
      const { reelIds } = analysisPayload.parse(row.payload)
      const analysis = new StyleAnalysis(ctx.deps, ctx.log, provider)
      let last = 0
      const r = await analysis.analyse(row.userId!, {
        reelIds,
        deleteSources: true,
        onProgress: (done, total) => {
          const progress = Math.min(95, Math.round((done / Math.max(1, total)) * 95))
          if (progress !== last) {
            last = progress
            void mark(ctx, row.id, { progress }).catch(() => undefined)
          }
        },
      })
      ctx.log.info({ jobId: row.id, ...r }, 'style analysis finished')
      result = { ...r }
      break
    }
    case 'style_sync':
    case 'style_refresh': {
      if (!ctx.deps.instagram) {
        result = { skipped: 'instagram is not set up' }
        break
      }
      const sync = new InstagramSync(ctx.deps, ctx.log, ctx.deps.instagram)
      if (row.type === 'style_refresh') {
        result = { ...(await sync.refreshToken(row.userId!)) }
        break
      }
      let last = 0
      result = {
        ...(await sync.sync(row.userId!, provider, (done, total) => {
          const progress = Math.min(95, Math.round((done / Math.max(1, total)) * 95))
          if (progress !== last) {
            last = progress
            void mark(ctx, row.id, { progress }).catch(() => undefined)
          }
        })),
      }
      ctx.log.info({ jobId: row.id, ...result }, 'instagram sync finished')
      break
    }
    case 'style_deletion': {
      const { prefix, uploads } = deletionPayload.parse(row.payload)
      // Only ever a person's style folder: never anything broader.
      if (!/^users\/[0-9a-f-]{36}\/style\/$/.test(prefix))
        throw new Error(`refusing to delete unexpected prefix: ${prefix}`)
      for (const u of uploads)
        await ctx.deps.storage.abortMultipart(u.key, u.uploadId).catch(() => undefined)
      const removed = await ctx.deps.storage.deletePrefix(prefix)
      ctx.log.info(
        { jobId: row.id, removed, abortedUploads: uploads.length },
        'style data deleted from storage',
      )
      result = { removed, abortedUploads: uploads.length }
      break
    }
    default:
      throw new Error(`the style worker cannot run a '${row.type}' job`)
  }

  await mark(ctx, row.id, { status: 'done', progress: 100, result, finishedAt: new Date() })
  return result
}

/** What the row says when a job is out of retries, by what it was doing. Never the error itself: that can name a file or an address. */
const GIVEN_UP: Record<string, { message: string; code: string }> = {
  style_analysis: { message: 'Analysis could not be completed.', code: 'ANALYSIS_FAILED' },
  style_sync: { message: 'Instagram could not be read just now.', code: 'SYNC_FAILED' },
  style_refresh: {
    message: 'The Instagram connection could not be renewed.',
    code: 'REFRESH_FAILED',
  },
  style_deletion: { message: 'Stored files could not be deleted yet.', code: 'DELETION_FAILED' },
}

/**
 * A try failed. While tries remain the queue waits (longer each time) and runs it again. When they run out the row says so,
 * and the queue keeps the failed job (the dead-letter path: `npm run jobs:dead` lists them), so nothing is lost silently.
 */
export function onStyleJobFailed(
  ctx: WorkerContext,
  bull: Pick<BullJob<JobData>, 'data' | 'attemptsMade' | 'opts' | 'name'>,
  e: Error,
): Promise<void> {
  const exhausted = bull.attemptsMade >= (bull.opts.attempts ?? 1)
  ctx.log.warn(
    { jobId: bull.data.jobId, type: bull.name, attempt: bull.attemptsMade, exhausted, err: e },
    exhausted ? 'style job gave up' : 'style job attempt failed',
  )
  if (!exhausted) return Promise.resolve()
  const why = GIVEN_UP[bull.name] ?? GIVEN_UP['style_analysis']!
  return mark(ctx, bull.data.jobId, {
    status: 'failed',
    error: why.message,
    errorCode: why.code,
    finishedAt: new Date(),
  }).catch((err) => ctx.log.error({ err, jobId: bull.data.jobId }, 'could not record a failed job'))
}

export function createStyleWorker(
  ctx: WorkerContext,
  provider: TranscriptionProvider,
): Worker<JobData> {
  const worker = new Worker<JobData>(QUEUES.style, (bull) => processStyleJob(ctx, provider, bull), {
    connection: createRedis(ctx.deps.config, bullConnectionOptions),
    concurrency: ctx.deps.config.STYLE_CONCURRENCY,
    lockDuration: 60_000,
  })
  worker.on('error', (e) => ctx.log.error({ err: e }, 'style worker error'))
  worker.on('failed', (bull, e) => {
    if (bull) void onStyleJobFailed(ctx, bull, e)
  })
  return worker
}
