import { and, eq } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { jobs } from '../../db/schema/index.js'
import { err } from '../../lib/errors.js'
import { UUID_RE } from '../../lib/ids.js'
import { requeueProcessingJob } from '../../pipeline/retry.js'
import { isUserVisibleJob, toJobDto, type JobDto } from './dto.js'

type JobRow = typeof jobs.$inferSelect

export class JobService {
  constructor(private readonly deps: AppDeps) {}

  private get db() {
    return this.deps.database.db
  }

  /**
   * A job the caller owns, or null. The owner is in the query, so another user's job is never read, and a
   * job that does not exist answers exactly the same way as one that is not yours.
   */
  async find(userId: string, jobId: string): Promise<JobRow | null> {
    if (!UUID_RE.test(jobId)) return null
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    return row && isUserVisibleJob(row) ? row : null
  }

  async get(userId: string, jobId: string): Promise<JobDto> {
    const row = await this.find(userId, jobId)
    if (!row) throw err.notFound('Job')
    return toJobDto(row)
  }

  /**
   * Retries a failed processing job. It picks up at the stage that failed (see requeueProcessingJob) and keeps
   * its id. Asking again while it is already queued or running just returns where it is, so a double click is safe.
   */
  async retry(userId: string, jobId: string): Promise<JobDto> {
    const row = await this.find(userId, jobId)
    if (!row || row.type !== 'processing') throw err.notFound('Job')
    if (row.status === 'queued' || row.status === 'running') return toJobDto(row)
    if (row.status === 'done') throw err.conflict('CONFLICT', 'This job already finished.')

    await requeueProcessingJob(this.deps, row.id)
    return this.get(userId, jobId)
  }
}
