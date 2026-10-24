import type { Config } from '../lib/config.js'
import type { Database } from '../db/client.js'
import type { Storage } from '../lib/storage.js'
import type { Redis } from 'ioredis'
import type { Queues } from '../queue/queues.js'

/** Everything the API needs from the outside world. Tests build the app from the same shape. */
export interface AppDeps {
  config: Config
  database: Database
  redis: Redis
  storage: Storage
  queues: Queues
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
    /** True once shutdown has begun, so /ready fails and load balancers drain this instance. */
    draining: boolean
  }
}
