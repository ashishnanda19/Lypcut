/** Queue names in one place. The API enqueues; workers consume. */
export const QUEUES = {
  processing: 'processing',
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
