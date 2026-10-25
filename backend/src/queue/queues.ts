import { Queue, type JobsOptions } from 'bullmq'
import type { Config } from '../lib/config.js'
import { bullConnectionOptions, createRedis } from './connection.js'

/** Queue names in one place. The API enqueues; workers consume. */
export const QUEUES = {
  processing: 'processing',
  maintenance: 'maintenance',
  /** Style learning: measuring a creator's Reels. Its own queue, so it can run at a lower concurrency than editing work. */
  style: 'style',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/** What every BullMQ job carries: the id of its row in the `jobs` table, which is the source of truth. */
export interface JobData {
  jobId: string
}

/**
 * Retries with exponential backoff. Failed jobs are kept (removeOnFail: false), which is the
 * dead-letter path: they stay inspectable in Redis and in the `jobs` table.
 */
export const jobOptions = (
  config: Pick<Config, 'JOB_ATTEMPTS' | 'JOB_BACKOFF_MS'>,
): JobsOptions => ({
  attempts: config.JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: config.JOB_BACKOFF_MS },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: false,
})

/**
 * The style queue waits longer between tries: what usually fails there is Instagram saying to slow down, or storage and speech
 * recognition being briefly away, and neither is fixed in two seconds.
 */
export const styleJobOptions = (
  config: Pick<Config, 'JOB_ATTEMPTS' | 'STYLE_JOB_BACKOFF_MS'>,
): JobsOptions => ({
  ...jobOptions({ JOB_ATTEMPTS: config.JOB_ATTEMPTS, JOB_BACKOFF_MS: config.STYLE_JOB_BACKOFF_MS }),
})

export interface Queues {
  processing: Queue<JobData>
  maintenance: Queue<JobData>
  style: Queue<JobData>
  close(): Promise<void>
}

export function createQueues(
  config: Pick<Config, 'REDIS_URL' | 'JOB_ATTEMPTS' | 'JOB_BACKOFF_MS'> &
    Partial<Pick<Config, 'STYLE_JOB_BACKOFF_MS'>>,
): Queues {
  const connection = createRedis(config, bullConnectionOptions)
  connection.on('error', () => undefined)
  const make = (name: QueueName, defaultJobOptions: JobsOptions = jobOptions(config)) =>
    new Queue<JobData>(name, { connection, defaultJobOptions })
  const processing = make(QUEUES.processing)
  const maintenance = make(QUEUES.maintenance)
  const style = make(
    QUEUES.style,
    styleJobOptions({
      JOB_ATTEMPTS: config.JOB_ATTEMPTS,
      STYLE_JOB_BACKOFF_MS: config.STYLE_JOB_BACKOFF_MS ?? 30_000,
    }),
  )
  return {
    processing,
    maintenance,
    style,
    close: async () => {
      await Promise.all([processing.close(), maintenance.close(), style.close()])
      connection.disconnect()
    },
  }
}
