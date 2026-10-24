import { loadConfigOrExit } from '../lib/bootstrap.js'
import { Pool } from 'pg'
import { migrateDown } from './down.js'

// npm run db:migrate:down [steps]   Undoes the newest migration (or the newest N). For development, never production.
const config = loadConfigOrExit()
if (config.NODE_ENV === 'production') {
  console.error('Refusing to undo migrations in production.')
  process.exit(1)
}
const steps = Number(process.argv[2] ?? 1)
const pool = new Pool({ connectionString: config.DATABASE_URL })
const undone = await migrateDown(pool, new URL('../../drizzle', import.meta.url).pathname, steps)
console.log(undone.length ? `undone: ${undone.join(', ')}` : 'nothing to undo')
await pool.end()
