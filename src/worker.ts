import http from 'node:http'
import pino from 'pino'
import { closeDeps, createDeps } from './app/deps.js'
import { loadConfigOrExit, onShutdown } from './lib/bootstrap.js'
import { loggerOptions } from './lib/logger.js'
import {
  createMaintenanceWorker,
  scheduleMaintenance,
  type WorkerContext,
} from './workers/maintenance.js'

/**
 * Worker process: consumes BullMQ queues. Stateless, so any number can run side by side.
 * Processors are registered in src/workers as each pipeline step lands.
 */
const config = loadConfigOrExit()
const deps = createDeps(config)
const log = pino(loggerOptions(config, 'worker'))

let draining = false

// A tiny health endpoint so Docker, ECS and Kubernetes can probe the worker.
const health = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.url === '/health') return send(200, { status: 'ok' })
  if (req.url === '/ready') {
    if (draining) return send(503, { status: 'draining' })
    Promise.all([deps.database.ping(), deps.redis.ping()]).then(
      () => send(200, { status: 'ready' }),
      () => send(503, { status: 'not_ready' }),
    )
    return
  }
  send(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } })
})
health.listen(config.WORKER_HEALTH_PORT, config.HOST)

const ctx: WorkerContext = { deps, log }
const maintenance = createMaintenanceWorker(ctx)
await scheduleMaintenance(ctx)

log.info({ port: config.WORKER_HEALTH_PORT }, 'worker started')

onShutdown(config.SHUTDOWN_TIMEOUT_MS, async (signal) => {
  log.info({ signal }, 'worker shutting down')
  draining = true
  // close() lets a running job finish and stops taking new ones.
  await maintenance.close()
  await new Promise<void>((resolve) => health.close(() => resolve()))
  await closeDeps(deps)
  log.info('worker shutdown complete')
})
