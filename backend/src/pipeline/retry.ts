import { and, eq, inArray } from 'drizzle-orm'
import type { AppDeps } from '../app/types.js'
import { jobs, jobStages, projects } from '../db/schema/index.js'
import { enqueueJob } from '../queue/enqueue.js'

/**
 * Puts a failed processing job back on the queue. Stages that finished stay finished (their rows are kept),
 * so it restarts at the stage that failed, not from zero. The job keeps its id, as the front end expects.
 */
export async function requeueProcessingJob(deps: AppDeps, jobId: string): Promise<void> {
  const { db } = deps.database
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  if (!job || job.type !== 'processing') return

  await db.transaction(async (tx) => {
    await tx
      .update(jobs)
      .set({
        status: 'queued',
        error: null,
        errorCode: null,
        attempts: 0,
        finishedAt: null,
        startedAt: null,
      })
      .where(eq(jobs.id, jobId))
    // A stage that failed gets another go; finished stages are left alone.
    await tx
      .update(jobStages)
      .set({ status: 'pending', error: null })
      .where(and(eq(jobStages.jobId, jobId), inArray(jobStages.status, ['failed', 'running'])))
    if (job.projectId) {
      await tx
        .update(projects)
        .set({ status: 'processing', error: null })
        .where(eq(projects.id, job.projectId))
    }
  })

  // The failed BullMQ job still holds this id (failed jobs are kept as dead letters), so clear it first.
  await deps.queues.processing.remove(jobId).catch(() => undefined)
  await enqueueJob(deps.queues, { id: jobId, type: 'processing' })
}
