import { eq } from 'drizzle-orm'
import type { AppDeps } from '../app/types.js'
import { jobs } from '../db/schema/index.js'
import type { JobFound } from '../db/schema/jobs.js'

/** The Redis channel every job change is published on. The API's live-delivery layer listens to it. */
export const JOB_EVENTS_CHANNEL = 'jobs:events'

export interface JobEvent {
  jobId: string
  userId: string | null
  projectId: string | null
}

export interface ProgressUpdate {
  progress?: number
  step?: number
  detail?: string
  stage?: string | null
  found?: JobFound
  status?: 'queued' | 'running' | 'done' | 'failed'
  error?: string | null
  errorCode?: string | null
  attempts?: number
}

/**
 * Writes a job's progress to the database (the source of truth) and announces the change on Redis so
 * anyone watching hears about it at once. Rapid progress ticks are collapsed: the row is written when
 * the number moves by a whole percent, or at least twice a second, whichever the stage produces.
 */
export class Reporter {
  private found: JobFound = {}
  private lastProgress = -1
  private lastWrite = 0

  constructor(
    private readonly deps: AppDeps,
    private readonly job: { id: string; userId: string | null; projectId: string | null },
  ) {}

  /** Findings so far, so a resumed job starts from what earlier attempts already learned. */
  seed(found: JobFound) {
    this.found = { ...found }
  }

  async update(patch: ProgressUpdate, opts: { force?: boolean } = {}): Promise<void> {
    if (patch.found) this.found = { ...this.found, ...patch.found }
    const now = Date.now()
    const onlyProgress = Object.keys(patch).every((k) => k === 'progress')
    if (onlyProgress && !opts.force) {
      const p = Math.round(patch.progress ?? 0)
      if (p === this.lastProgress || now - this.lastWrite < 500) return
    }
    if (patch.progress !== undefined) this.lastProgress = Math.round(patch.progress)
    this.lastWrite = now

    await this.deps.database.db
      .update(jobs)
      .set({
        ...(patch.progress !== undefined ? { progress: Math.round(patch.progress) } : {}),
        ...(patch.step !== undefined ? { step: patch.step } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.status === 'done' || patch.status === 'failed' ? { finishedAt: new Date() } : {}),
        found: this.found,
      })
      .where(eq(jobs.id, this.job.id))
    await this.announce()
  }

  /** Tell watchers the job changed. Losing a message is harmless: watchers also poll the row. */
  async announce(): Promise<void> {
    const event: JobEvent = {
      jobId: this.job.id,
      userId: this.job.userId,
      projectId: this.job.projectId,
    }
    await this.deps.redis.publish(JOB_EVENTS_CHANNEL, JSON.stringify(event)).catch(() => undefined)
  }
}
