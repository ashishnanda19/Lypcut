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
        'reels',
        'reel_analysis',
        'style_profiles',
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

  it('undoes the newest migration and only that one, keeping the data that is not style data', async () => {
    // One person with a project and its video, plus style rows of every kind that the migration touched.
    const user = (
      await pool.query(
        "insert into users (id, email, name, password_hash) values (gen_random_uuid(), 'm@example.com', 'M', 'x') returning id",
      )
    ).rows[0]!.id as string
    const project = (
      await pool.query(
        "insert into projects (id, owner_id, title, status, thumb_seed) values (gen_random_uuid(), $1, 'P', 'ready', 's') returning id",
        [user],
      )
    ).rows[0]!.id as string
    await pool.query(
      "insert into assets (id, project_id, kind, storage_key, label) values (gen_random_uuid(), $1, 'raw', 'k-raw', 'raw')",
      [project],
    )
    await pool.query(
      "insert into assets (id, user_id, kind, storage_key, label) values (gen_random_uuid(), $1, 'style_reel', 'k-style', 'reel')",
      [user],
    )
    await pool.query(
      "insert into llm_usage (id, user_id, kind, provider, model, outcome) values (gen_random_uuid(), $1, 'style', 'fake', 'fake', 'ok')",
      [user],
    )
    await pool.query(
      "insert into llm_usage (id, user_id, kind, provider, model, outcome) values (gen_random_uuid(), $1, 'planner', 'fake', 'fake', 'ok')",
      [user],
    )
    await pool.query(
      "insert into jobs (id, user_id, type, step, detail) values (gen_random_uuid(), $1, 'style_sync', 0, 'x')",
      [user],
    )
    await pool.query(
      "insert into jobs (id, user_id, project_id, type, step, detail) values (gen_random_uuid(), $1, $2, 'processing', 0, 'x')",
      [user, project],
    )

    const before = await applied()
    expect(await tables()).toContain('reels')
    expect(await hasColumn('assets', 'user_id')).toBe(true)
    const undone = await migrateDown(pool, folder, 1)
    expect(undone).toHaveLength(1)
    expect(await applied()).toBe(before - 1)
    const t = await tables()
    for (const gone of [
      'instagram_accounts',
      'reels',
      'reel_metrics',
      'reel_analysis',
      'style_profiles',
      'oauth_states',
    ])
      expect(t).not.toContain(gone)
    expect(await hasColumn('assets', 'user_id')).toBe(false)
    // Style data is gone; everything else is still there.
    const count = async (sql: string) => Number((await pool.query(sql)).rows[0]!.n)
    expect(await count("select count(*) as n from assets where kind = 'raw'")).toBe(1)
    expect(await count('select count(*) as n from assets')).toBe(1)
    expect(await count("select count(*) as n from llm_usage where kind = 'planner'")).toBe(1)
    expect(await count('select count(*) as n from llm_usage')).toBe(1)
    expect(await count("select count(*) as n from jobs where type = 'processing'")).toBe(1)
    expect(await count('select count(*) as n from jobs')).toBe(1)
    // The enums are back to what they were.
    const labels = async (type: string) =>
      (
        await pool.query<{ l: string }>(
          'select e.enumlabel as l from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1',
          [type],
        )
      ).rows.map((r) => r.l)
    expect(await labels('asset_kind')).not.toContain('style_reel')
    expect(await labels('job_type')).not.toContain('style_sync')
    expect(await labels('llm_kind')).not.toContain('style')
    expect(await tables()).toContain('edit_plans')
    expect(await hasColumn('llm_usage', 'request_id')).toBe(true)
    await pool.query('delete from users')
    // Put the schema back for the next test.
    await migrate(drizzle(pool), { migrationsFolder: folder })
    expect(await tables()).toContain('reels')
    await migrateDown(pool, folder, 1)
  })

  it('can undo the ones before that too', async () => {
    await migrateDown(pool, folder, 1)
    expect(await hasColumn('llm_usage', 'request_id')).toBe(false)
    expect(await tables()).toContain('edit_plans')
    await migrateDown(pool, folder, 1)
    expect(await tables()).not.toContain('edit_plans')
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
