import { sql } from 'drizzle-orm'
import { createDatabase, type Database } from '../../src/db/client.js'
import { loadConfig } from '../../src/lib/config.js'
import { TEST_ENV } from './env.js'

export function createTestDatabase(): Database {
  return createDatabase(loadConfig(TEST_ENV))
}

/** Empties every table. Deleting users cascades to nearly everything; the rest is cleaned explicitly. */
export async function resetDatabase(database: Database): Promise<void> {
  await database.db.execute(sql`truncate table users, jobs, usage_events restart identity cascade`)
}
