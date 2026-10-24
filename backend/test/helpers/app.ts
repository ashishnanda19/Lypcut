import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app/build.js'
import { closeDeps, createDeps } from '../../src/app/deps.js'
import type { AppDeps } from '../../src/app/types.js'
import { loadConfig } from '../../src/lib/config.js'
import { TEST_ENV } from './env.js'

export interface TestApp {
  app: FastifyInstance
  deps: AppDeps
  close(): Promise<void>
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const deps = createDeps(loadConfig({ ...TEST_ENV, ...overrides }))
  const app = await buildApp(deps)
  return {
    app,
    deps,
    close: async () => {
      await app.close()
      await closeDeps(deps)
    },
  }
}
