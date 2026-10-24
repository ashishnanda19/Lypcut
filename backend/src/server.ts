import { buildApp } from './app/build.js'
import { closeDeps, createDeps } from './app/deps.js'
import { loadConfigOrExit, onShutdown } from './lib/bootstrap.js'

const config = loadConfigOrExit()
const deps = createDeps(config)
const app = await buildApp(deps)

onShutdown(config.SHUTDOWN_TIMEOUT_MS, async (signal) => {
  app.log.info({ signal }, 'shutting down')
  // Fail /ready first so the load balancer stops routing here, then finish in-flight requests.
  app.draining = true
  await app.close()
  await closeDeps(deps)
  app.log.info('shutdown complete')
})

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (e) {
  app.log.fatal({ err: e }, 'could not start')
  process.exit(1)
}
