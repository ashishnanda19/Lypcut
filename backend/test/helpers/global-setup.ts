import path from 'node:path'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Redis } from 'ioredis'
import { loadConfig } from '../../src/lib/config.js'
import { Storage } from '../../src/lib/storage.js'
import { TEST_ENV } from './env.js'

/**
 * Makes sure the test database, Redis db and bucket exist, and rebuilds the schema from the
 * migrations on every run, so the migrations themselves are tested and no state leaks between runs.
 */
export default async function setup() {
  const config = loadConfig(TEST_ENV)
  const hint = 'Start the test infrastructure first:  docker compose up -d postgres redis minio'
  try {
    const url = new URL(config.DATABASE_URL)
    const dbName = url.pathname.slice(1)
    url.pathname = '/postgres'
    const admin = new Client({ connectionString: url.toString() })
    await admin.connect()
    const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName])
    if (exists.rowCount === 0) await admin.query(`create database "${dbName.replace(/"/g, '')}"`)
    await admin.end()

    const pool = new Pool({ connectionString: config.DATABASE_URL })
    await pool.query('drop schema if exists drizzle cascade')
    await pool.query('drop schema if exists public cascade')
    await pool.query('create schema public')
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle'),
    })
    await pool.end()

    const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 })
    await redis.flushdb()
    redis.disconnect()

    const storage = new Storage(config)
    await storage.ensureBucket()
    storage.destroy()
  } catch (e) {
    throw new Error(`${hint}\n(${e instanceof Error ? e.message : String(e)})`, { cause: e })
  }
}
