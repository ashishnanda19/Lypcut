import type { JobType } from '../db/schema/jobs.js'
import type { Queues } from './queues.js'

const MAINTENANCE_TYPES: ReadonlySet<JobType> = new Set([
  'delete_project',
  'delete_account',
  'cleanup_uploads',
])

/**
 * Puts a `jobs` row on the right BullMQ queue. The BullMQ job id is the row id, so enqueueing the
 * same row twice (for example by the reconcile sweep) is a no-op rather than a duplicate.
 */
export async function enqueueJob(
  queues: Queues,
  row: { id: string; type: JobType },
): Promise<void> {
  const queue = MAINTENANCE_TYPES.has(row.type) ? queues.maintenance : queues.processing
  await queue.add(row.type, { jobId: row.id }, { jobId: row.id })
}
