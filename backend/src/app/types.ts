import type { Config } from '../lib/config.js'
import type { Database } from '../db/client.js'
import type { Storage } from '../lib/storage.js'
import type { Redis } from 'ioredis'
import type { Queues } from '../queue/queues.js'
import type { EmbeddingProvider, Llm } from '../llm/index.js'
import type { InstagramClient } from '../style/instagram/client.js'
import type { TokenVault } from '../style/instagram/vault.js'

/** Everything the API needs from the outside world. Tests build the app from the same shape. */
export interface AppDeps {
  config: Config
  database: Database
  redis: Redis
  storage: Storage
  queues: Queues
  /** The language model: Claude when a key is set, the offline model otherwise. */
  llm: Llm
  /** Turns text into vectors for search. */
  embeddings: EmbeddingProvider
  /** Seals and opens Instagram tokens. Only the style module's workers and the connect callback use it. */
  vault: TokenVault
  /** Instagram, read-only. Null when it is not set up (production without a Meta app): the feature is then not offered. */
  instagram: InstagramClient | null
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
    /** True once shutdown has begun, so /ready fails and load balancers drain this instance. */
    draining: boolean
  }
}
