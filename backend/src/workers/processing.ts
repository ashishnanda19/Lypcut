import { Worker } from 'bullmq'
import { bullConnectionOptions, createRedis } from '../queue/connection.js'
import { QUEUES, type JobData } from '../queue/queues.js'
import { processProject } from '../pipeline/runner.js'
import type { TranscriptionProvider } from '../transcription/types.js'
import type { WorkerContext } from './maintenance.js'

/**
 * Consumes the processing queue. Concurrency is capped by PROCESSING_CONCURRENCY because this is video
 * work: each job runs FFmpeg and holds a copy of the upload on disk. Failures are retried with backoff by
 * the queue; a job out of attempts stays in the queue's failed set (the dead-letter path) and its row says
 * `failed`, from where the user can retry it.
 */
export function createProcessingWorker(
  ctx: WorkerContext,
  provider: TranscriptionProvider,
): Worker<JobData> {
  const worker = new Worker<JobData>(
    QUEUES.processing,
    (bull) => processProject({ deps: ctx.deps, log: ctx.log, provider }, bull),
    {
      connection: createRedis(ctx.deps.config, bullConnectionOptions),
      concurrency: ctx.deps.config.PROCESSING_CONCURRENCY,
      // FFmpeg runs in child processes, so the event loop stays free and the lock is renewed; this is only
      // generous headroom for a slow database moment.
      lockDuration: 60_000,
    },
  )
  worker.on('error', (e) => ctx.log.error({ err: e }, 'processing worker error'))
  worker.on('failed', (bull, e) => {
    ctx.log.warn(
      { jobId: bull?.data.jobId, attempt: bull?.attemptsMade, err: e },
      'processing job attempt failed',
    )
  })
  return worker
}
