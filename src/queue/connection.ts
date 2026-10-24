import { Redis, type RedisOptions } from 'ioredis'
import type { Config } from '../lib/config.js'

/** BullMQ workers require maxRetriesPerRequest: null; plain clients fail fast instead. */
export function createRedis(cfg: Pick<Config, 'REDIS_URL'>, opts: RedisOptions = {}): Redis {
  return new Redis(cfg.REDIS_URL, { lazyConnect: false, enableReadyCheck: true, ...opts })
}

export const bullConnectionOptions: RedisOptions = { maxRetriesPerRequest: null }
