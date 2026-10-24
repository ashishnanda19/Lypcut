import { pino } from 'pino'
import type { Worker } from 'bullmq'
import type { AppDeps } from '../../src/app/types.js'
import { createMaintenanceWorker } from '../../src/workers/maintenance.js'

/** Runs the real BullMQ maintenance worker against the test Redis. Call close() when done. */
export function startMaintenanceWorker(deps: AppDeps): { worker: Worker; close(): Promise<void> } {
  const worker = createMaintenanceWorker({ deps, log: pino({ level: 'silent' }) })
  return { worker, close: () => worker.close() }
}

/** Polls until `check` returns a value (not undefined/false), or fails after the timeout. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
