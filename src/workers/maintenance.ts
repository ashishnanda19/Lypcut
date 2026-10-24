import { and, eq, inArray, lt } from 'drizzle-orm'
import { Worker, type Job as BullJob } from 'bullmq'
import type { Logger } from 'pino'
import type { AppDeps } from '../app/types.js'
import { jobs, sessions } from '../db/schema/index.js'
import { z } from 'zod'
import { enqueueJob } from '../queue/enqueue.js'
import { bullConnectionOptions, createRedis } from '../queue/connection.js'
import { QUEUES, type JobData } from '../queue/queues.js'

export interface WorkerContext {
  deps: AppDeps
  log: Logger
}

/** A queued row older than this with no BullMQ job behind it is re-enqueued by the sweep. */
const RECONCILE_AFTER_MS = 60_000
const RECONCILE_EVERY_MS = 60_000

async function markJob(ctx: WorkerContext, id: string, patch: Partial<typeof jobs.$inferInsert>) {
  await ctx.deps.database.db.update(jobs).set(patch).where(eq(jobs.id, id))
}

const deletePayload = z.object({
  prefix: z.string(),
  /** Multipart uploads that were still in flight when the project or account was deleted. */
  uploads: z.array(z.object({ key: z.string(), uploadId: z.string() })).default([]),
})

/** Deletes every object under a prefix. Used after a project or an account row is gone. */
async function deleteStorage(
  ctx: WorkerContext,
  jobId: string,
  { prefix, uploads }: z.infer<typeof deletePayload>,
) {
  // The prefix always names a user or project folder; refuse anything that could be broader.
  if (!/^users\/[0-9a-f-]{36}\/(projects\/[0-9a-f-]{36}\/)?$/.test(prefix)) {
    throw new Error(`refusing to delete unexpected prefix: ${prefix}`)
  }
  // In-flight uploads first: their parts are not objects, so deleting the prefix would miss them.
  for (const u of uploads) await ctx.deps.storage.abortMultipart(u.key, u.uploadId)
  const removed = await ctx.deps.storage.deletePrefix(prefix)
  ctx.log.info({ jobId, removed, abortedUploads: uploads.length }, 'storage cleaned')
  return { removed, abortedUploads: uploads.length }
}

/**
 * Safety net: the jobs table is the source of truth, and the queue can miss an add (a crash between
 * commit and enqueue). Anything still 'queued' after a minute is put on the queue again. Adding the
 * same BullMQ job id twice is a no-op, so this cannot cause duplicates.
 */
export async function reconcileQueuedJobs(ctx: WorkerContext): Promise<number> {
  const { db } = ctx.deps.database
  const stale = await db
    .select({ id: jobs.id, type: jobs.type })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'queued'),
        lt(jobs.createdAt, new Date(Date.now() - RECONCILE_AFTER_MS)),
        inArray(jobs.type, ['delete_project', 'delete_account', 'cleanup_uploads']),
      ),
    )
  for (const row of stale) await enqueueJob(ctx.deps.queues, row)
  return stale.length
}

/** Login sessions are kept a week past expiry (for reuse detection and support), then dropped. */
export async function purgeExpiredSessions(ctx: WorkerContext): Promise<number> {
  const gone = await ctx.deps.database.db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(Date.now() - 7 * 24 * 3600 * 1000)))
    .returning({ id: sessions.id })
  return gone.length
}

export async function processMaintenanceJob(ctx: WorkerContext, bull: BullJob<JobData>) {
  if (bull.name === 'reconcile') {
    return {
      requeued: await reconcileQueuedJobs(ctx),
      sessionsPurged: await purgeExpiredSessions(ctx),
    }
  }

  const { db } = ctx.deps.database
  const [row] = await db.select().from(jobs).where(eq(jobs.id, bull.data.jobId))
  if (!row) return { skipped: 'job row is gone' }
  if (row.status === 'done') return { skipped: 'already done' }

  await markJob(ctx, row.id, {
    status: 'running',
    startedAt: new Date(),
    attempts: bull.attemptsMade + 1,
    error: null,
  })

  let result: Record<string, unknown>
  switch (row.type) {
    case 'delete_account':
    case 'delete_project': {
      result = await deleteStorage(ctx, row.id, deletePayload.parse(row.payload))
      break
    }
    default:
      throw new Error(`maintenance worker cannot run a '${row.type}' job`)
  }

  await markJob(ctx, row.id, { status: 'done', progress: 100, result, finishedAt: new Date() })
  return result
}

export function createMaintenanceWorker(ctx: WorkerContext): Worker<JobData> {
  const worker = new Worker<JobData>(
    QUEUES.maintenance,
    (bull) => processMaintenanceJob(ctx, bull),
    {
      connection: createRedis(ctx.deps.config, bullConnectionOptions),
      concurrency: ctx.deps.config.WORKER_CONCURRENCY,
    },
  )
  worker.on('error', (e) => ctx.log.error({ err: e }, 'maintenance worker error'))
  worker.on('failed', (bull, e) => {
    if (!bull) return
    const exhausted = bull.attemptsMade >= (bull.opts.attempts ?? 1)
    ctx.log.warn(
      { jobId: bull.data.jobId, attempt: bull.attemptsMade, exhausted, err: e },
      'job failed',
    )
    // Out of retries: record it. BullMQ keeps the failed job (the dead-letter path).
    if (exhausted && bull.name !== 'reconcile') {
      void markJob(ctx, bull.data.jobId, {
        status: 'failed',
        error: e.message,
        finishedAt: new Date(),
      })
    }
  })
  return worker
}

/** The recurring safety-net job. Safe to call on every worker start: the scheduler id makes it idempotent. */
export async function scheduleMaintenance(ctx: WorkerContext): Promise<void> {
  await ctx.deps.queues.maintenance.upsertJobScheduler(
    'reconcile',
    { every: RECONCILE_EVERY_MS },
    { name: 'reconcile', data: { jobId: 'reconcile' } },
  )
}
