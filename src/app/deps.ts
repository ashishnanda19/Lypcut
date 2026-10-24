import type { Config } from '../lib/config.js'
import { createDatabase } from '../db/client.js'
import { createRedis } from '../queue/connection.js'
import { Storage } from '../lib/storage.js'
import type { AppDeps } from './types.js'

export function createDeps(config: Config): AppDeps {
  return {
    config,
    database: createDatabase(config),
    redis: createRedis(config, { maxRetriesPerRequest: 2 }),
    storage: new Storage(config),
  }
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  deps.storage.destroy()
  deps.redis.disconnect()
  await deps.database.close()
}
