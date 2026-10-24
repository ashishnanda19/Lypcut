import type { Config } from '../lib/config.js'
import { createDatabase } from '../db/client.js'
import { createRedis } from '../queue/connection.js'
import { createQueues } from '../queue/queues.js'
import { Storage } from '../lib/storage.js'
import pino from 'pino'
import { createEmbeddings, createLlm } from '../llm/index.js'
import { createInstagramClient } from '../style/instagram/index.js'
import { createVault } from '../style/instagram/vault.js'
import { loggerOptions } from '../lib/logger.js'
import { fakeChapters, fakeHighlights } from '../highlights/fake.js'
import { fakePlanner } from '../planner/fake.js'
import { fakeStyle } from '../style/analysis/fake.js'
import type { AppDeps } from './types.js'

export function createDeps(config: Config): AppDeps {
  const database = createDatabase(config)
  return {
    config,
    database,
    redis: createRedis(config, { maxRetriesPerRequest: 2 }),
    storage: new Storage(config),
    queues: createQueues(config),
    llm: createLlm(config, {
      db: database.db,
      log: pino(loggerOptions(config, 'llm')),
      handlers: {
        highlights: fakeHighlights,
        chapters: fakeChapters,
        planner: fakePlanner,
        style: fakeStyle,
      },
    }),
    embeddings: createEmbeddings(config, pino(loggerOptions(config, 'llm'))),
    vault: createVault(config),
    instagram: createInstagramClient(config),
  }
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await deps.queues.close()
  deps.storage.destroy()
  deps.redis.disconnect()
  await deps.database.close()
}
