import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { jobs } from '../db/schema/index.js'
import type { Queues } from './queues.js'

export interface DeadLetter {
  queue: string
  jobId: string
  type: string
  attempts: number
  failedAt: string | null
  /** The queue's own record of why. For operators: it is never shown to a person. */
  reason: string
  /** Who it belongs to, if it belongs to anyone. */
  userId: string | null
}

/**
 * Jobs that used up every try. The queue keeps them (removeOnFail is off), and this is how an operator finds them:
 * `npm run jobs:dead`. Each is also a `jobs` row with status `failed`, which is what the person sees.
 */
export async function listDeadLetters(queues: Queues, database: Database): Promise<DeadLetter[]> {
  const out: DeadLetter[] = []
  for (const queue of [queues.processing, queues.maintenance, queues.style]) {
    for (const bull of await queue.getFailed(0, 199)) {
      const [row] = await database.db
        .select({ userId: jobs.userId })
        .from(jobs)
        .where(eq(jobs.id, bull.data.jobId))
      out.push({
        queue: queue.name,
        jobId: bull.data.jobId,
        type: bull.name,
        attempts: bull.attemptsMade,
        failedAt: bull.finishedOn ? new Date(bull.finishedOn).toISOString() : null,
        reason: bull.failedReason ?? '',
        userId: row?.userId ?? null,
      })
    }
  }
  return out
}

/** Gives one dead letter a fresh set of tries, once whatever broke it is fixed. Returns false if there is no such failed job. */
export async function retryDeadLetter(
  queues: Queues,
  database: Database,
  jobId: string,
): Promise<boolean> {
  for (const queue of [queues.processing, queues.maintenance, queues.style]) {
    const bull = await queue.getJob(jobId)
    if (!bull || !(await bull.isFailed())) continue
    await database.db
      .update(jobs)
      .set({ status: 'queued', error: null, errorCode: null, finishedAt: null })
      .where(eq(jobs.id, jobId))
    await bull.retry('failed', { resetAttemptsMade: true })
    return true
  }
  return false
}
