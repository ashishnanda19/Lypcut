import { count, eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/client.js'
import {
  assets,
  jobs,
  jobStages,
  projects,
  scenes,
  timelines,
  timelineVersions,
  transcriptSentences,
  transcriptWords,
  users,
} from '../../src/db/schema/index.js'
import { createTestDatabase, resetDatabase } from '../helpers/db.js'
import { makeFullProject, makeProject, makeUser } from '../helpers/factories.js'

let database: Database
const rows = async (table: string) =>
  Number(
    (await database.db.execute<{ n: string }>(sql.raw(`select count(*)::int as n from ${table}`)))
      .rows[0]!.n,
  )

beforeEach(async () => {
  database ??= createTestDatabase()
  await resetDatabase(database)
})
afterAll(() => database.close())

/** Runs a statement that must be rejected, and returns Postgres's error text. */
async function rejected(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    // drizzle wraps the driver error; the original message is on `cause`.
    const cause = (e as { cause?: Error }).cause
    return `${(e as Error).message} ${cause?.message ?? ''}`
  }
  throw new Error('expected the statement to be rejected')
}

describe('migrations', () => {
  it('create every table and the trigram extension', async () => {
    const tables = await database.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(
      [
        'assets',
        'chapters',
        'highlights',
        'job_stages',
        'jobs',
        'llm_usage',
        'projects',
        'scenes',
        'sentence_embeddings',
        'sessions',
        'silences',
        'timeline_ops',
        'timeline_versions',
        'timelines',
        'transcript_sentences',
        'transcript_words',
        'transcripts',
        'uploads',
        'usage_events',
        'user_preferences',
        'users',
      ].sort(),
    )
    const ext = await database.db.execute(sql`select 1 from pg_extension where extname = 'pg_trgm'`)
    expect(ext.rowCount).toBe(1)
  })

  it('give every table a uuid primary key (except user_preferences, keyed by its user)', async () => {
    const r = await database.db.execute<{ table_name: string; data_type: string }>(sql`
      select kcu.table_name, c.data_type
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      join information_schema.columns c
        on c.table_name = kcu.table_name and c.column_name = kcu.column_name and c.table_schema = 'public'
      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'`)
    expect(r.rows.length).toBe(21)
    expect(r.rows.every((x) => x.data_type === 'uuid')).toBe(true)
  })

  it('index words and scenes by (project, start)', async () => {
    const r = await database.db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    )
    const def = (name: string) => r.rows.find((x) => x.indexname === name)?.indexdef ?? ''
    expect(def('words_project_start_idx')).toMatch(/\(project_id, start_sec\)/)
    expect(def('scenes_project_start_idx')).toMatch(/\(project_id, start_sec\)/)
    expect(def('sentences_search_idx')).toMatch(/USING gin/)
    expect(def('sentences_norm_trgm_idx')).toMatch(/gin_trgm_ops/)
  })

  it('stamp created_at and move updated_at on change', async () => {
    const user = await makeUser(database)
    expect(user.createdAt).toBeInstanceOf(Date)
    await new Promise((r) => setTimeout(r, 15))
    const [after] = await database.db
      .update(users)
      .set({ name: 'Renamed' })
      .where(eq(users.id, user.id))
      .returning()
    expect(after!.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
    expect(after!.createdAt.getTime()).toBe(user.createdAt.getTime())
  })
})

describe('constraints', () => {
  it('emails are unique', async () => {
    const a = await makeUser(database)
    const msg = await rejected(() => makeUser(database, { email: a.email }))
    expect(msg).toMatch(/users_email_uq|duplicate key/)
  })

  it('a project needs a real owner', async () => {
    const msg = await rejected(() =>
      database.db
        .insert(projects)
        .values({ ownerId: '00000000-0000-7000-8000-000000000000', title: 'x', thumbSeed: 'x' }),
    )
    expect(msg).toMatch(/foreign key/)
  })

  it('rejects impossible values', async () => {
    const user = await makeUser(database)
    const project = await makeProject(database, user.id)
    expect(
      await rejected(() =>
        database.db.update(projects).set({ durationSec: -1 }).where(eq(projects.id, project.id)),
      ),
    ).toMatch(/projects_duration_nonneg/)
    expect(
      await rejected(() =>
        database.db
          .insert(scenes)
          .values({ projectId: project.id, idx: 0, label: 'x', startSec: 5, endSec: 5 }),
      ),
    ).toMatch(/scenes_range/)
    expect(
      await rejected(() =>
        database.db
          .insert(jobs)
          .values({ userId: user.id, projectId: project.id, type: 'processing', progress: 101 }),
      ),
    ).toMatch(/jobs_progress/)
  })

  it('rejects values outside an enum', async () => {
    const user = await makeUser(database)
    expect(
      await rejected(() =>
        database.db.execute(sql`update projects set status = 'bogus' where owner_id = ${user.id}`),
      ),
    ).toBeTruthy()
    expect(
      await rejected(() =>
        database.db.execute(sql`update users set plan = 'bogus' where id = ${user.id}`),
      ),
    ).toMatch(/invalid input value for enum/)
  })

  it('a scene index and a timeline version number cannot repeat', async () => {
    const user = await makeUser(database)
    const { project, timeline } = await makeFullProject(database, user.id)
    expect(
      await rejected(() =>
        database.db
          .insert(scenes)
          .values({ projectId: project.id, idx: 0, label: 'dup', startSec: 20, endSec: 30 }),
      ),
    ).toMatch(/scenes_project_idx_uq/)
    expect(
      await rejected(() =>
        database.db.insert(timelineVersions).values({
          timelineId: timeline.id,
          n: 0,
          createdBy: 'user',
          label: 'dup',
          snapshot: {},
          op: {},
          inverse: {},
        }),
      ),
    ).toMatch(/timeline_versions_n_uq/)
  })

  it('a timeline cursor cannot point past the last version', async () => {
    const user = await makeUser(database)
    const { timeline } = await makeFullProject(database, user.id)
    expect(
      await rejected(() =>
        database.db
          .update(timelines)
          .set({ currentVersion: 5, lastVersion: 2 })
          .where(eq(timelines.id, timeline.id)),
      ),
    ).toMatch(/timelines_versions/)
  })

  it('one transcript and one timeline per project', async () => {
    const user = await makeUser(database)
    const { project } = await makeFullProject(database, user.id)
    expect(
      await rejected(() =>
        database.db.insert(timelines).values({ projectId: project.id, sourceDuration: 1 }),
      ),
    ).toMatch(/timelines_project_uq/)
  })
})

describe('deletion', () => {
  it('deleting a project removes everything under it', async () => {
    const user = await makeUser(database)
    const { project } = await makeFullProject(database, user.id)
    await database.db.delete(projects).where(eq(projects.id, project.id))
    for (const t of [
      'assets',
      'scenes',
      'uploads',
      'transcripts',
      'transcript_words',
      'transcript_sentences',
      'highlights',
      'chapters',
      'silences',
      'timelines',
      'timeline_versions',
      'timeline_ops',
      'jobs',
      'job_stages',
      'llm_usage',
    ]) {
      expect(await rows(t), t).toBe(0)
    }
    // The user, their sessions and their usage history stay.
    expect(await rows('users')).toBe(1)
    expect(await rows('sessions')).toBe(1)
    expect(await rows('usage_events')).toBe(1)
  })

  it('deleting an account removes every row that belongs to it, and nobody else’s', async () => {
    const a = await makeUser(database)
    const b = await makeUser(database)
    await makeFullProject(database, a.id)
    await makeFullProject(database, b.id)

    await database.db.delete(users).where(eq(users.id, a.id))

    for (const t of [
      'projects',
      'assets',
      'scenes',
      'uploads',
      'transcripts',
      'transcript_words',
      'transcript_sentences',
      'highlights',
      'chapters',
      'silences',
      'timelines',
      'timeline_versions',
      'timeline_ops',
      'jobs',
      'job_stages',
      'usage_events',
      'llm_usage',
      'sessions',
      'user_preferences',
      'users',
    ]) {
      expect(await rows(t), `${t} should hold only the other user's rows`).toBe(
        // users, user_preferences, projects etc: one each. Tables with several rows per project differ.
        t === 'transcript_words' ? 2 : 1,
      )
    }
  })

  it('a cleanup job outlives the account it cleans up', async () => {
    const user = await makeUser(database)
    const [job] = await database.db
      .insert(jobs)
      .values({ userId: user.id, type: 'delete_account', payload: { prefix: `users/${user.id}/` } })
      .returning()
    await database.db.delete(users).where(eq(users.id, user.id))
    const [after] = await database.db.select().from(jobs).where(eq(jobs.id, job!.id))
    expect(after?.userId).toBeNull()
    expect(after?.payload).toEqual({ prefix: `users/${user.id}/` })
  })

  it('the asset <-> scene reference is circular but never blocks deleting either side', async () => {
    const user = await makeUser(database)
    const { raw, scene } = await makeFullProject(database, user.id)
    await database.db.delete(scenes).where(eq(scenes.id, scene.id))
    const [a] = await database.db.select().from(assets).where(eq(assets.id, raw.id))
    expect(a?.sceneId).toBeNull()
  })
})

describe('transcript search structures', () => {
  async function seed() {
    const user = await makeUser(database)
    const { project, transcript } = await makeFullProject(database, user.id)
    await database.db.insert(transcriptSentences).values([
      {
        transcriptId: transcript.id,
        projectId: project.id,
        idx: 1,
        speaker: 's1',
        fromWord: 2,
        toWord: 6,
        startSec: 10,
        endSec: 14,
        text: 'investors ko pitch deck bhejo',
        dev: 'इन्वेस्टर्स को पिच डेक भेजो',
        norm: 'investors ko pitch deck bhejo',
      },
      {
        transcriptId: transcript.id,
        projectId: project.id,
        idx: 2,
        speaker: 's1',
        fromWord: 6,
        toWord: 9,
        startSec: 14,
        endSec: 18,
        text: 'hiring ka sach',
        dev: 'हायरिंग का सच',
        norm: 'hiring ka sach',
      },
    ])
    return project
  }

  it('fills the generated tsvector from both scripts', async () => {
    const project = await seed()
    const roman = await database.db.execute(
      sql`select 1 from transcript_sentences where project_id = ${project.id} and search @@ plainto_tsquery('simple', 'pitch')`,
    )
    const devanagari = await database.db.execute(
      sql`select 1 from transcript_sentences where project_id = ${project.id} and search @@ plainto_tsquery('simple', 'हायरिंग')`,
    )
    expect(roman.rowCount).toBe(1)
    expect(devanagari.rowCount).toBe(1)
  })

  it('finds fuzzy Hinglish spellings with trigram similarity', async () => {
    const project = await seed()
    const r = await database.db.execute<{ norm: string }>(
      sql`select norm from transcript_sentences
          where project_id = ${project.id} and word_similarity('invester', norm) > 0.4
          order by word_similarity('invester', norm) desc`,
    )
    expect(r.rows[0]?.norm).toBe('investors ko pitch deck bhejo')
  })

  it('reads a time range of words through the (project, start) index', async () => {
    const user = await makeUser(database)
    const { project, transcript } = await makeFullProject(database, user.id)
    await database.db.insert(transcriptWords).values(
      Array.from({ length: 2000 }, (_, i) => ({
        transcriptId: transcript.id,
        projectId: project.id,
        idx: 10 + i,
        text: `w${i}`,
        dev: `w${i}`,
        norm: `w${i}`,
        startSec: 100 + i * 0.3,
        endSec: 100 + i * 0.3 + 0.2,
        speaker: 's1',
        language: 'en' as const,
      })),
    )
    await database.db.execute(sql`analyze transcript_words`)
    const plan = await database.db.execute<{ 'QUERY PLAN': string }>(sql`
      explain select * from transcript_words
      where project_id = ${project.id} and start_sec between 300 and 310`)
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toMatch(/words_project_start_idx/)
    const [n] = await database.db.select({ n: count() }).from(transcriptWords)
    expect(n!.n).toBe(2002)
  })
})

describe('jobs and stages', () => {
  it('a stage is recorded once per job', async () => {
    const user = await makeUser(database)
    const { job } = await makeFullProject(database, user.id)
    expect(
      await rejected(() => database.db.insert(jobStages).values({ jobId: job.id, stage: 'probe' })),
    ).toMatch(/job_stages_job_stage_uq/)
  })
})
