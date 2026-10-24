import { eq } from 'drizzle-orm'
import { Worker, type Job as BullJob } from 'bullmq'
import { z } from 'zod'
import { jobs } from '../db/schema/index.js'
import { bullConnectionOptions, createRedis } from '../queue/connection.js'
import { QUEUES, type JobData } from '../queue/queues.js'
import { StyleAnalysis } from '../style/analysis/service.js'
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
      throw new Error(`the style worker cannot run a '${row.type}' job yet`)
  }

  await mark(ctx, row.id, { status: 'done', progress: 100, result, finishedAt: new Date() })
  return result
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
    if (!bull) return
    const exhausted = bull.attemptsMade >= (bull.opts.attempts ?? 1)
    ctx.log.warn(
      { jobId: bull.data.jobId, attempt: bull.attemptsMade, exhausted, err: e },
      'style job attempt failed',
    )
    // Out of retries: the row says so (the queue keeps the failed job, which is the dead-letter path).
    if (exhausted)
      void mark(ctx, bull.data.jobId, {
        status: 'failed',
        error: 'Analysis could not be completed.',
        errorCode: 'ANALYSIS_FAILED',
        finishedAt: new Date(),
      }).catch(() => undefined)
  })
  return worker
}
