import { Client } from 'pg'
import { Redis } from 'ioredis'
import { loadConfig } from '../../src/lib/config.js'
import { Storage } from '../../src/lib/storage.js'
import { TEST_ENV } from './env.js'

/** Makes sure the test database, Redis db and bucket exist, with a clear message if the stack is down. */
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
