import path from 'node:path'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateDown } from '../../src/db/down.js'
import { loadConfig } from '../../src/lib/config.js'
import { TEST_ENV } from '../helpers/env.js'

const folder = path.resolve(import.meta.dirname, '../../drizzle')
const NAME = 'lypcut_migrations_test'
let pool: Pool

beforeAll(async () => {
  const url = new URL(loadConfig(TEST_ENV).DATABASE_URL)
  url.pathname = '/postgres'
  const admin = new Client({ connectionString: url.toString() })
  await admin.connect()
  await admin.query(`drop database if exists ${NAME} with (force)`)
  await admin.query(`create database ${NAME}`)
  await admin.end()
  url.pathname = `/${NAME}`
  pool = new Pool({ connectionString: url.toString() })
})
afterAll(async () => {
  await pool.end()
})

const tables = async () =>
  (
    await pool.query<{ t: string }>(
      "select table_name as t from information_schema.tables where table_schema = 'public' order by 1",
    )
  ).rows.map((r) => r.t)
const applied = async () =>
  Number(
    (
      await pool
        .query('select count(*) as n from drizzle.__drizzle_migrations')
        .catch(() => ({ rows: [{ n: 0 }] }))
    ).rows[0]!.n,
  )

describe('migrations go up and down cleanly', () => {
  it('applies every migration', async () => {
    await migrate(drizzle(pool), { migrationsFolder: folder })
    const t = await tables()
    expect(t).toEqual(
      expect.arrayContaining([
        'users',
        'projects',
        'transcripts',
        'llm_usage',
        'sentence_embeddings',
      ]),
    )
    expect(await applied()).toBeGreaterThanOrEqual(2)
  })

  const hasColumn = async (table: string, column: string) =>
    (
      await pool.query(
        "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
        [table, column],
      )
    ).rowCount === 1

  it('undoes the newest migration and only that one', async () => {
    const before = await applied()
    expect(await tables()).toContain('edit_plans')
    const undone = await migrateDown(pool, folder, 1)
    expect(undone).toHaveLength(1)
    expect(await applied()).toBe(before - 1)
    expect(await tables()).not.toContain('edit_plans')
    // The ones before it are still there.
    expect(await tables()).toContain('sentence_embeddings')
    expect(await hasColumn('transcripts', 'content_hash')).toBe(true)
    expect(await tables()).toContain('llm_usage')
  })

  it('can undo the ones before that too', async () => {
    await migrateDown(pool, folder, 1)
    expect(await tables()).not.toContain('sentence_embeddings')
    expect(await hasColumn('transcripts', 'embeddings_hash')).toBe(false)
    await migrateDown(pool, folder, 1)
    expect(await hasColumn('transcripts', 'content_hash')).toBe(false)
    await migrateDown(pool, folder, 1)
    const t = await tables()
    expect(t).not.toContain('llm_usage')
    expect(t).toContain('users')
  })

  it('applies it again', async () => {
    await migrate(drizzle(pool), { migrationsFolder: folder })
    expect(await tables()).toContain('llm_usage')
  })

  it('undoes everything and leaves an empty schema, then rebuilds it', async () => {
    await migrateDown(pool, folder, 99)
    expect(await tables()).toEqual([])
    await migrate(drizzle(pool), { migrationsFolder: folder })
    expect(await tables()).toContain('llm_usage')
    expect(
      (await pool.query("select count(*) as n from pg_type where typname = 'llm_kind'")).rows[0]!.n,
    ).toBe('1')
  })

  it('has a down file for every migration in the journal', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const journal = JSON.parse(
      readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    for (const { tag } of journal.entries)
      expect(existsSync(path.join(folder, 'down', `${tag}.sql`)), tag).toBe(true)
  })
})
