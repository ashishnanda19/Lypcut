import { Queue, type JobsOptions } from 'bullmq'
import type { Config } from '../lib/config.js'
import { bullConnectionOptions, createRedis } from './connection.js'

/** Queue names in one place. The API enqueues; workers consume. */
export const QUEUES = {
  processing: 'processing',
  maintenance: 'maintenance',
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
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: false,
}

export interface Queues {
  processing: Queue<JobData>
  maintenance: Queue<JobData>
  close(): Promise<void>
}

export function createQueues(config: Pick<Config, 'REDIS_URL'>): Queues {
  const connection = createRedis(config, bullConnectionOptions)
  connection.on('error', () => undefined)
  const make = (name: QueueName) =>
    new Queue<JobData>(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS })
  const processing = make(QUEUES.processing)
  const maintenance = make(QUEUES.maintenance)
  return {
    processing,
    maintenance,
    close: async () => {
      await Promise.all([processing.close(), maintenance.close()])
      connection.disconnect()
    },
  }
}
