import { ConfigError, loadConfig, type Config } from './config.js'

/** Loads config or exits with a readable message instead of a stack trace. */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig()
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\nSee .env.example for every variable.\n`)
      process.exit(1)
    }
    throw e
  }
}

/**
 * Runs `shutdown` once on SIGTERM or SIGINT, and force-exits if it takes longer than the timeout.
 * ECS and Kubernetes send SIGTERM first and SIGKILL after a grace period.
 */
export function onShutdown(timeoutMs: number, shutdown: (signal: string) => Promise<void>): void {
  let started = false
  const handle = (signal: string) => {
    if (started) return
    started = true
    const timer = setTimeout(() => process.exit(1), timeoutMs)
    timer.unref()
    shutdown(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGTERM', () => handle('SIGTERM'))
  process.on('SIGINT', () => handle('SIGINT'))
}
