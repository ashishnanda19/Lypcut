import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

/**
 * Drizzle only goes forward. Every migration `NNNN_name.sql` has a hand-written `down/NNNN_name.sql`, and this
 * runs them newest first, forgetting each in drizzle's own bookkeeping so the migrator would apply it again. A
 * test migrates all the way up, all the way down and up again, so a down file that is missing or wrong is caught.
 */
export async function migrateDown(pool: Pool, folder: string, steps = 1): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: Array<{ tag: string }>
  }
  const undone: string[] = []
  for (let i = 0; i < steps; i++) {
    const applied = await pool
      .query<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations')
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0)
    if (applied === 0) break
    const tag = journal.entries[applied - 1]?.tag
    if (!tag)
      throw new Error(`The database has ${applied} migrations applied but the journal lists fewer.`)
    const sql = await readFile(path.join(folder, 'down', `${tag}.sql`), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.query(statement)
      }
      // The first migration's down file drops the whole schema, bookkeeping included.
      await client
        .query(
          `delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`,
        )
        .catch(() => undefined)
      await client.query('commit')
    } catch (e) {
      await client.query('rollback')
      throw new Error(`Could not undo ${tag}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    } finally {
      client.release()
    }
    undone.push(tag)
  }
  return undone
}
