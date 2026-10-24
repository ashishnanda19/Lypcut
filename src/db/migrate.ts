import { existsSync } from 'node:fs'
import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { loadConfigOrExit } from '../lib/bootstrap.js'
import { createDatabase } from './client.js'

const config = loadConfigOrExit()
const database = createDatabase(config)
const folder = new URL('../../drizzle', import.meta.url).pathname

if (existsSync(path.join(folder, 'meta', '_journal.json'))) {
  await migrate(database.db, { migrationsFolder: folder })
  console.log('migrations applied')
} else {
  console.log('no migrations yet')
}
await database.close()
