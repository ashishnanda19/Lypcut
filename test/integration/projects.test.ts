import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assets, jobs, projects, uploads, usageEvents } from '../../src/db/schema/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeVideo } from '../helpers/media.js'
import { fullUpload, putParts, startUpload } from '../helpers/upload.js'
import { startMaintenanceWorker, waitFor } from '../helpers/worker.js'
import { signup } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp({ UPLOAD_PART_SIZE_MB: '5' })
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

const db = () => t.deps.database.db

describe('creating a project', () => {
  it('makes an empty project waiting for its video', async () => {
    const { c, id } = await signup(t)
    const res = await c.post('/api/projects', { fileName: 'My_Podcast.Ep.12.mp4' })
    expect(res.status).toBe(201)
    const p = res.body.project
    expect(p).toMatchObject({
      title: 'My Podcast Ep 12',
      status: 'uploading',
      durationSec: 0,
      language: 'hinglish',
      assets: [],
    })
    expect(p.thumbSeed).toBe(p.id)
    expect(new Date(p.createdAt).toString()).not.toBe('Invalid Date')

    const [row] = await db().select().from(projects).where(eq(projects.id, p.id))
    expect(row!.ownerId).toBe(id)
    // The plan's limits are snapshotted, so a later plan change does not rewrite history.
    expect(row!.planLimits).toEqual({ maxVideoSeconds: 600, maxUploadsPerMonth: 3 })
  })

  it('uses an explicit title when given, and trims it', async () => {
    const { c } = await signup(t)
    const res = await c.post('/api/projects', { fileName: 'a.mp4', title: '  Funding talk  ' })
    expect(res.body.project.title).toBe('Funding talk')
  })

  it('validates the input', async () => {
    const { c } = await signup(t)
    expect((await c.post('/api/projects', {})).status).toBe(422)
    expect((await c.post('/api/projects', { fileName: '' })).status).toBe(422)
    expect((await c.post('/api/projects', { fileName: 'a.mp4', durationSec: -5 })).status).toBe(422)
  })
})

describe('plan limits when creating', () => {
  it('refuses a video the browser says is over 10 minutes, before any upload', async () => {
    const { c } = await signup(t)
    const res = await c.post('/api/projects', { fileName: 'long.mp4', durationSec: 11 * 60 })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({
      code: 'LIMIT_VIDEO_LENGTH',
      details: { maxSeconds: 600 },
    })
    expect(res.body.error.message).toMatch(/10 minutes/)
    expect((await c.get('/api/projects')).body).toEqual([])
  })

  it('accepts exactly 10 minutes, and the rounding slack just above it', async () => {
    const { c } = await signup(t)
    expect((await c.post('/api/projects', { fileName: 'a.mp4', durationSec: 600 })).status).toBe(
      201,
    )
    expect((await c.post('/api/projects', { fileName: 'b.mp4', durationSec: 600.6 })).status).toBe(
      201,
    )
  })

  it('a paid plan allows longer videos', async () => {
    const { c } = await signup(t, 'creator')
    expect(
      (await c.post('/api/projects', { fileName: 'a.mp4', durationSec: 40 * 60 })).status,
    ).toBe(201)
  })

  it('refuses a fourth upload in a month with LIMIT_MONTHLY_UPLOADS', async () => {
    const { c, id } = await signup(t)
    await db()
      .insert(usageEvents)
      .values(Array.from({ length: 3 }, () => ({ userId: id, kind: 'upload' as const, amount: 1 })))
    const res = await c.post('/api/projects', { fileName: 'a.mp4' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'LIMIT_MONTHLY_UPLOADS', details: { max: 3 } })
    expect(res.body.error.message).toMatch(/all 3 uploads/)
  })

  it('only counts this month: last month’s uploads do not use up the allowance', async () => {
    const { c, id } = await signup(t)
    const lastMonth = new Date()
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
    lastMonth.setUTCDate(15)
    await db()
      .insert(usageEvents)
      .values(
        Array.from({ length: 3 }, () => ({
          userId: id,
          kind: 'upload' as const,
          amount: 1,
          createdAt: lastMonth,
        })),
      )
    expect((await c.post('/api/projects', { fileName: 'a.mp4' })).status).toBe(201)
  })

  it('counts other people’s uploads for no one', async () => {
    const a = await signup(t)
    const b = await signup(t)
    await db()
      .insert(usageEvents)
      .values(
        Array.from({ length: 3 }, () => ({ userId: a.id, kind: 'upload' as const, amount: 1 })),
      )
    expect((await b.c.post('/api/projects', { fileName: 'a.mp4' })).status).toBe(201)
  })
})

describe('reading projects', () => {
  it('lists only your own, most recently changed first', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const first = (await a.c.post('/api/projects', { fileName: 'first.mp4' })).body.project
    const second = (await a.c.post('/api/projects', { fileName: 'second.mp4' })).body.project
    await b.c.post('/api/projects', { fileName: 'bs.mp4' })

    expect((await a.c.get('/api/projects')).body.map((p: { id: string }) => p.id)).toEqual([
      second.id,
      first.id,
    ])
    await a.c.patch(`/api/projects/${first.id}`, { title: 'Renamed first' })
    expect((await a.c.get('/api/projects')).body[0].id).toBe(first.id)
    expect((await b.c.get('/api/projects')).body).toHaveLength(1)
  })

  it('an empty account has an empty list', async () => {
    const { c } = await signup(t)
    expect((await c.get('/api/projects')).body).toEqual([])
  })

  it('gets one project', async () => {
    const { c } = await signup(t)
    const p = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
    const res = await c.get(`/api/projects/${p.id}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(p.id)
  })

  it('answers 404 for an unknown or malformed id', async () => {
    const { c } = await signup(t)
    expect((await c.get('/api/projects/01a16c25-3f8a-7ae1-b315-a86a3c00a69b')).status).toBe(404)
    expect((await c.get('/api/projects/not-a-uuid')).status).toBe(404)
    expect((await c.get("/api/projects/1'%20or%20'1'='1")).status).toBe(404)
  })
})

describe('renaming a project', () => {
  it('renames and trims', async () => {
    const { c } = await signup(t)
    const p = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
    const res = await c.patch(`/api/projects/${p.id}`, { title: '  Better name  ' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Better name')
    expect((await c.get(`/api/projects/${p.id}`)).body.title).toBe('Better name')
  })

  it('refuses an empty or very long name', async () => {
    const { c } = await signup(t)
    const p = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
    expect((await c.patch(`/api/projects/${p.id}`, { title: '   ' })).status).toBe(422)
    expect((await c.patch(`/api/projects/${p.id}`, { title: 'x'.repeat(121) })).status).toBe(422)
  })
})

describe('deleting a project', () => {
  it('removes the rows at once and the files in the background, including an upload in flight', async () => {
    const { c, id } = await signup(t)
    const file = await makeVideo({ seconds: 6, padToBytes: 12 * 1024 * 1024 })
    const { projectId, upload } = await startUpload(c, file)
    const [u] = await db().select().from(uploads).where(eq(uploads.id, upload.id))
    // One part is in storage, the rest never will be.
    await putParts(c, upload, file, [1])

    const res = await c.del(`/api/projects/${projectId}`)
    expect(res.status).toBe(200)
    expect(await db().select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0)
    expect((await c.get(`/api/projects/${projectId}`)).status).toBe(404)

    const [job] = await db().select().from(jobs).where(eq(jobs.type, 'delete_project'))
    expect(job!.payload).toMatchObject({ prefix: `users/${id}/projects/${projectId}/` })

    const worker = startMaintenanceWorker(t.deps)
    try {
      await waitFor(
        async () =>
          (await db().select().from(jobs).where(eq(jobs.id, job!.id)))[0]?.status === 'done',
        20_000,
        'project cleanup',
      )
    } finally {
      await worker.close()
    }
    // The half-sent multipart upload was aborted: its parts no longer exist.
    await expect(t.deps.storage.listParts(u!.storageKey, u!.s3UploadId)).rejects.toThrow()
  })

  it('removes a finished project’s files and queued processing job', async () => {
    const { c, id } = await signup(t)
    const file = await makeVideo({ seconds: 5 })
    const { projectId, done } = await fullUpload(c, file)
    expect(done.status).toBe(200)
    const jobId = done.body.job.id
    expect(await t.deps.queues.processing.getJob(jobId)).toBeTruthy()

    const rawKey = (await db().select().from(assets)).find((a) => a.kind === 'raw')!.storageKey
    expect(await t.deps.storage.head(rawKey)).not.toBeNull()

    expect((await c.del(`/api/projects/${projectId}`)).status).toBe(200)
    // The queued processing job was withdrawn, so no work is wasted on a deleted project.
    expect(await t.deps.queues.processing.getJob(jobId)).toBeFalsy()

    const worker = startMaintenanceWorker(t.deps)
    try {
      await waitFor(
        async () => (await t.deps.storage.head(rawKey)) === null,
        20_000,
        'file removal',
      )
    } finally {
      await worker.close()
    }
    expect(id).toBeTruthy()
  })

  it('does not touch another user’s project with the same title', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const mine = (await a.c.post('/api/projects', { fileName: 'same.mp4' })).body.project
    const theirs = (await b.c.post('/api/projects', { fileName: 'same.mp4' })).body.project
    expect((await a.c.del(`/api/projects/${mine.id}`)).status).toBe(200)
    expect((await b.c.get(`/api/projects/${theirs.id}`)).status).toBe(200)
  })
})
