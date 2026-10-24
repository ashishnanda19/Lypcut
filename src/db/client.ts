import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import type { Config } from '../lib/config.js'
import * as schema from './schema/index.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

export interface Database {
  db: Db
  pool: Pool
  ping(): Promise<void>
  close(): Promise<void>
}

export function createDatabase(cfg: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): Database {
  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  // An idle client erroring (for example a Postgres restart) must not crash the process.
  pool.on('error', () => undefined)
  return {
    db: drizzle(pool, { schema, casing: 'snake_case' }),
    pool,
    ping: async () => {
      await pool.query('select 1')
    },
    close: () => pool.end(),
  }
}
