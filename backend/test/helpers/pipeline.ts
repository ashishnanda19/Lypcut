import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Redis } from 'ioredis'
import { pino } from 'pino'
import type { Worker } from 'bullmq'
import type { AppDeps } from '../../src/app/types.js'
import { jobs } from '../../src/db/schema/index.js'
import { JOB_EVENTS_CHANNEL } from '../../src/pipeline/reporter.js'
import type { TranscriptionProvider } from '../../src/transcription/types.js'
import { createProcessingWorker } from '../../src/workers/processing.js'
import { waitFor } from './worker.js'

export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lypcut-test-tmp-'))

export function startProcessing(deps: AppDeps, provider: TranscriptionProvider) {
  const worker: Worker = createProcessingWorker({ deps, log: pino({ level: 'silent' }) }, provider)
  return { worker, close: () => worker.close() }
}

export async function jobRow(deps: AppDeps, id: string) {
  const [row] = await deps.database.db.select().from(jobs).where(eq(jobs.id, id))
  return row!
}

export const waitForJob = (
  deps: AppDeps,
  id: string,
  status: 'done' | 'failed',
  timeoutMs = 90_000,
) =>
  waitFor(
    async () => {
      const row = await jobRow(deps, id)
      return row.status === status ? row : false
    },
    timeoutMs,
    `job ${id} to be ${status}`,
  )

export interface Snapshot {
  status: string
  progress: number
  step: number | null
  detail: string | null
  stage: string | null
}

/**
 * Records every state a job passes through, the way a live viewer would see it: it listens for the same
 * Redis announcements and reads the row each time.
 */
export async function watchJob(deps: AppDeps, id: string) {
  const sub = new Redis(deps.config.REDIS_URL)
  await sub.subscribe(JOB_EVENTS_CHANNEL)
  const seen: Snapshot[] = []
  let chain = Promise.resolve()
  sub.on('message', (_c, msg) => {
    if (JSON.parse(msg).jobId !== id) return
    chain = chain.then(async () => {
      const r = await jobRow(deps, id)
      seen.push({
        status: r.status,
        progress: r.progress,
        step: r.step,
        detail: r.detail,
        stage: r.stage,
      })
    })
  })
  return {
    seen,
    stop: async () => {
      await chain
      sub.disconnect()
    },
  }
}
