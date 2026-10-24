import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assets, jobs, projects, uploads, usageEvents } from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'
import { sweepUploads } from '../../src/modules/uploads/cleanup.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeAudioOnly, makeGarbage, makePng, makeVideo, sha256File } from '../helpers/media.js'
import { fullUpload, putParts, startUpload } from '../helpers/upload.js'
import { signup } from '../helpers/world.js'

const MiB = 1024 * 1024
let t: TestApp
let small: string
let multi: string
let long: string

beforeAll(async () => {
  // 5 MiB parts (S3's minimum), so a 12 MiB file is a cheap three-part upload.
  t = await createTestApp({ UPLOAD_PART_SIZE_MB: '5' })
  small = await makeVideo({ seconds: 10 })
  multi = await makeVideo({ seconds: 6, padToBytes: 12 * MiB })
  long = await makeVideo({ seconds: 11 * 60, audio: false })
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

const db = () => t.deps.database.db
const log = pino({ level: 'silent' })
const uploadRow = async (id: string) =>
  (await db().select().from(uploads).where(eq(uploads.id, id)))[0]!

describe('a normal upload', () => {
  it('goes from start to a queued processing job without the video touching the API', async () => {
    const { c, id } = await signup(t)
    const { projectId, upload, res } = await startUpload(c, small, { durationSec: 10 })
    expect(res.status).toBe(201)
    expect(upload).toMatchObject({
      projectId,
      sizeBytes: fs.statSync(small).size,
      partSize: 5 * MiB,
      totalParts: 1,
    })
    expect(res.body.upload.status).toBe('initiated')
    expect(res.body.upload.parts).toEqual([])

    await putParts(c, upload, small)
    const done = await c.post(`/api/uploads/${upload.id}/complete`)
    expect(done.status, JSON.stringify(done.body)).toBe(200)

    // The upload, the project and the job all tell the same story.
    expect(done.body.upload.status).toBe('completed')
    expect(done.body.project).toMatchObject({ id: projectId, status: 'processing' })
    expect(done.body.project.durationSec).toBeGreaterThan(9.5)
    expect(done.body.project.durationSec).toBeLessThan(10.5)
    expect(done.body.project.assets).toEqual([
      expect.objectContaining({ kind: 'raw', label: 'My Podcast.mp4' }),
    ])
    expect(done.body.job).toMatchObject({
      kind: 'processing',
      status: 'queued',
      progress: 0,
      step: 0,
      detail: 'Uploaded',
      projectId,
    })

    // The measured facts come from ffprobe, not from the client.
    const [raw] = await db().select().from(assets).where(eq(assets.projectId, projectId))
    expect(raw).toMatchObject({
      kind: 'raw',
      status: 'ready',
      width: 160,
      height: 90,
      codec: 'h264',
      mimeType: 'video/mp4',
    })
    expect(raw!.storageKey).toMatch(new RegExp(`^users/${id}/projects/${projectId}/raw/.+\\.mp4$`))
    expect(await t.deps.storage.head(raw!.storageKey)).toMatchObject({ size: upload.sizeBytes })

    // Usage was recorded, and the job is on the queue under its row id.
    const usage = await db().select().from(usageEvents).where(eq(usageEvents.userId, id))
    expect(usage.map((u) => u.kind).sort()).toEqual(['upload', 'video_seconds'])
    expect(await t.deps.queues.processing.getJob(done.body.job.id)).toBeTruthy()
  })

  it('completing twice returns the same result instead of a second job', async () => {
    const { c } = await signup(t)
    const { upload, done } = await fullUpload(c, small)
    const again = await c.post(`/api/uploads/${upload.id}/complete`)
    expect(again.status).toBe(200)
    expect(again.body.job.id).toBe(done.body.job.id)
    expect(await db().select().from(jobs)).toHaveLength(1)
  })

  it('a project with its video cannot take another upload', async () => {
    const { c } = await signup(t)
    const { projectId } = await fullUpload(c, small)
    const again = await c.post('/api/uploads', {
      projectId,
      fileName: 'other.mp4',
      sizeBytes: 1000,
    })
    expect(again.status).toBe(409)
  })

  it('shows the finished project to the project list with its new status', async () => {
    const { c } = await signup(t)
    const { projectId } = await fullUpload(c, small)
    const list = (await c.get('/api/projects')).body
    expect(list[0]).toMatchObject({ id: projectId, status: 'processing' })
    expect(list[0].jobId).toBeTruthy()
  })
})

describe('multipart and resuming', () => {
  it('splits a bigger file into parts and stitches them back', async () => {
    const { c } = await signup(t)
    const { upload, done } = await fullUpload(c, multi)
    expect(upload.totalParts).toBe(3)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.upload.bytesReceived).toBe(fs.statSync(multi).size)
  })

  it('a client that comes back sees which parts arrived and sends only the rest', async () => {
    const { c } = await signup(t)
    const { projectId, upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1])

    // "Closed the tab". A fresh look at the state shows part 1 is safe.
    const state = await c.get(`/api/uploads/${upload.id}`)
    expect(state.body.upload.status).toBe('uploading')
    expect(state.body.upload.parts).toEqual([{ partNumber: 1, size: 5 * MiB }])
    expect(state.body.upload.bytesReceived).toBe(5 * MiB)

    // Starting the same file again resumes this upload rather than opening a second.
    const resumed = await c.post('/api/uploads', {
      projectId,
      fileName: 'My Podcast.mp4',
      contentType: 'video/mp4',
      sizeBytes: fs.statSync(multi).size,
    })
    expect(resumed.status).toBe(200)
    expect(resumed.body.upload.id).toBe(upload.id)

    // The project list shows progress for the half-sent file.
    const list = (await c.get('/api/projects')).body
    expect(list[0].progress).toBeGreaterThan(30)
    expect(list[0].progress).toBeLessThan(50)

    await putParts(c, upload, multi, [2, 3])
    const done = await c.post(`/api/uploads/${upload.id}/complete`)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
  })

  it('refuses to finish while parts are missing, and keeps what has arrived', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1, 3])
    const res = await c.post(`/api/uploads/${upload.id}/complete`)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'UPLOAD_INCOMPLETE', details: { missing: [2] } })

    // Nothing was thrown away: send the missing part and finish.
    expect((await uploadRow(upload.id)).status).toBe('uploading')
    await putParts(c, upload, multi, [2])
    expect((await c.post(`/api/uploads/${upload.id}/complete`)).status).toBe(200)
  })

  it('catches a part that arrived at the wrong size and lets the client resend it', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1, 2, 3], (part, data) =>
      part === 1 ? data.subarray(0, data.length - 10) : data,
    )
    const res = await c.post(`/api/uploads/${upload.id}/complete`)
    expect(res.status).toBe(422)
    expect(res.body.error.details.wrongSize).toEqual([1])

    await putParts(c, upload, multi, [1])
    expect((await c.post(`/api/uploads/${upload.id}/complete`)).status).toBe(200)
  })

  it('refuses a presigned request for a part the upload does not have', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, small)
    const res = await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [1, 2] })
    expect(res.status).toBe(422)
    expect(res.body.error.details.invalid).toEqual([2])
    expect((await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [] })).status).toBe(422)
    expect((await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [0] })).status).toBe(422)
  })

  it('presigned URLs are short lived and only good for the one write', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, small)
    const res = await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [1, 1] })
    expect(res.body.expiresIn).toBe(3600)
    expect(res.body.urls).toHaveLength(1)
    const { url } = res.body.urls[0]
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('3600')
    // A URL signed for writing a part cannot be used to read anything.
    const read = await fetch(url, { method: 'GET' })
    expect(read.status).toBe(403)
  })
})

describe('integrity', () => {
  it('accepts a matching SHA-256', async () => {
    const { c } = await signup(t)
    const { done } = await fullUpload(c, small, { checksum: sha256File(small) })
    expect(done.status).toBe(200)
    const [raw] = await db().select().from(assets)
    expect(raw!.checksum).toBe(sha256File(small))
  })

  it('rejects a wrong SHA-256, deletes the file and lets the user try again', async () => {
    const { c } = await signup(t)
    const { projectId, upload, done } = await fullUpload(c, small, { checksum: 'a'.repeat(64) })
    expect(done.status).toBe(422)
    expect(done.body.error.code).toBe('CHECKSUM_MISMATCH')

    const row = await uploadRow(upload.id)
    expect(row.status).toBe('failed')
    expect(await t.deps.storage.head(row.storageKey)).toBeNull()
    expect(await db().select().from(usageEvents)).toHaveLength(0)

    // The project is still waiting for a video, and a fresh upload works.
    const retry = await fullUpload(c, small, { projectId, checksum: sha256File(small) })
    expect(retry.done.status).toBe(200)
  })

  it('rejects a malformed checksum', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, small)
    await putParts(c, upload, small)
    expect((await c.post(`/api/uploads/${upload.id}/complete`, { checksum: 'nope' })).status).toBe(
      422,
    )
  })
})

describe('checking the file by its content', () => {
  const cases: Array<[string, () => Promise<string> | string]> = [
    ['random bytes named .mp4', () => makeGarbage()],
    ['a PNG image named .mp4', () => makePng()],
    ['an audio-only file named .mp4', () => makeAudioOnly()],
  ]
  for (const [name, make] of cases) {
    it(`refuses ${name}, and removes it`, async () => {
      const { c } = await signup(t)
      const file = await make()
      const { upload, done } = await fullUpload(c, file)
      expect(done.status).toBe(415)
      expect(done.body.error.code).toBe('UNSUPPORTED_MEDIA')
      const row = await uploadRow(upload.id)
      expect(row.status).toBe('failed')
      expect(await t.deps.storage.head(row.storageKey)).toBeNull()
      expect(await db().select().from(usageEvents)).toHaveLength(0)
    })
  }

  it('refuses by extension and declared type before any bytes are sent', async () => {
    const { c } = await signup(t)
    const project = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
    const start = (body: object) =>
      c.post('/api/uploads', { projectId: project.id, sizeBytes: 1000, ...body })
    expect((await start({ fileName: 'virus.exe' })).status).toBe(415)
    expect((await start({ fileName: 'notes.txt', contentType: 'text/plain' })).status).toBe(415)
    expect((await start({ fileName: 'a.mp4', contentType: 'text/html' })).status).toBe(415)
    expect((await start({ fileName: 'a.mp4', sizeBytes: 0 })).status).toBe(422)
    expect(
      (await start({ fileName: 'a.mp4', contentType: 'application/octet-stream' })).status,
    ).toBe(201)
  })

  it('refuses a file over the size limit', async () => {
    const small = await createTestApp({ MAX_UPLOAD_BYTES: '1000' })
    try {
      const { c } = await signup(small)
      const project = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
      const res = await c.post('/api/uploads', {
        projectId: project.id,
        fileName: 'a.mp4',
        sizeBytes: 1001,
      })
      expect(res.status).toBe(413)
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    } finally {
      await small.close()
    }
  })
})

describe('plan limits', () => {
  it('rejects an over-long video after upload using the measured length, ignoring what the client claimed', async () => {
    const { c, id } = await signup(t)
    // The browser claims 5 seconds; the file is 11 minutes.
    const { projectId, upload, done } = await fullUpload(c, long, { durationSec: 5 })
    expect(done.status).toBe(403)
    expect(done.body.error).toMatchObject({
      code: 'LIMIT_VIDEO_LENGTH',
      details: { maxSeconds: 600, durationSec: 660 },
    })
    expect(done.body.error.message).toMatch(/11 minutes/)

    // No processing was queued or paid for, the file is gone, and it did not use an upload.
    expect(await db().select().from(jobs)).toHaveLength(0)
    expect(await t.deps.queues.processing.getJobCountByTypes('waiting', 'active')).toBe(0)
    expect(await t.deps.storage.head((await uploadRow(upload.id)).storageKey)).toBeNull()
    expect(await db().select().from(usageEvents).where(eq(usageEvents.userId, id))).toHaveLength(0)
    expect((await c.get(`/api/projects/${projectId}`)).body.status).toBe('uploading')

    // A shorter video can still go into the same project.
    expect((await fullUpload(c, small, { projectId })).done.status).toBe(200)
  })

  it('accepts a measured length just under the limit', async () => {
    const { c } = await signup(t)
    const ten = await makeVideo({ seconds: 600, audio: false })
    expect((await fullUpload(c, ten)).done.status).toBe(200)
  })

  it('a paid plan accepts the long video', async () => {
    const { c } = await signup(t, 'creator')
    expect((await fullUpload(c, long)).done.status).toBe(200)
  })

  it('counts a finished upload, so the fourth one in a month is refused', async () => {
    const { c } = await signup(t)
    for (let i = 0; i < 3; i++) {
      const r = await fullUpload(c, small, { fileName: `v${i}.mp4` })
      expect(r.done.status, `upload ${i + 1}`).toBe(200)
    }
    const res = await c.post('/api/projects', { fileName: 'fourth.mp4' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('LIMIT_MONTHLY_UPLOADS')
  })

  it('does not count a rejected upload against the month', async () => {
    const { c } = await signup(t)
    for (let i = 0; i < 4; i++) {
      expect((await fullUpload(c, makeGarbage())).done.status).toBe(415)
    }
    // Four refused files later the full allowance is still there.
    for (let i = 0; i < 3; i++) expect((await fullUpload(c, small)).done.status).toBe(200)
  })

  it('counts uploads still in flight, and two starts at once cannot both slip through', async () => {
    const { c, id } = await signup(t)
    await db()
      .insert(usageEvents)
      .values(Array.from({ length: 2 }, () => ({ userId: id, kind: 'upload' as const, amount: 1 })))
    // Two projects made while only 2 of 3 uploads are used.
    const p1 = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project.id
    const p2 = (await c.post('/api/projects', { fileName: 'b.mp4' })).body.project.id

    const [a, b] = await Promise.all([
      startUpload(c, small, { projectId: p1 }),
      startUpload(c, small, { projectId: p2 }),
    ])
    expect([a.res.status, b.res.status].sort()).toEqual([201, 403])
    const refused = [a, b].find((x) => x.res.status === 403)!
    expect(refused.res.body.error.code).toBe('LIMIT_MONTHLY_UPLOADS')
  })

  it('aborting an upload gives its slot back', async () => {
    const { c, id } = await signup(t)
    await db()
      .insert(usageEvents)
      .values(Array.from({ length: 2 }, () => ({ userId: id, kind: 'upload' as const, amount: 1 })))
    const p1 = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project.id
    const p2 = (await c.post('/api/projects', { fileName: 'b.mp4' })).body.project.id
    const first = await startUpload(c, small, { projectId: p1 })
    expect((await startUpload(c, small, { projectId: p2 })).res.status).toBe(403)
    expect((await c.del(`/api/uploads/${first.upload.id}`)).status).toBe(200)
    expect((await startUpload(c, small, { projectId: p2 })).res.status).toBe(201)
  })
})

describe('starting an upload', () => {
  it('refuses a second, different upload for a project while one is open', async () => {
    const { c } = await signup(t)
    const { projectId, upload } = await startUpload(c, small)
    const other = await c.post('/api/uploads', {
      projectId,
      fileName: 'different.mp4',
      sizeBytes: 12345,
    })
    expect(other.status).toBe(409)
    expect(other.body.error.details.uploadId).toBe(upload.id)
  })

  it('refuses an early length check over the limit', async () => {
    const { c } = await signup(t)
    const project = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project
    const res = await c.post('/api/uploads', {
      projectId: project.id,
      fileName: 'a.mp4',
      sizeBytes: 1000,
      durationSec: 3600,
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('LIMIT_VIDEO_LENGTH')
  })
})

describe('aborting', () => {
  it('stops the upload and releases the parts held in storage', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1])
    const row = await uploadRow(upload.id)
    expect((await t.deps.storage.listParts(row.storageKey, row.s3UploadId)).length).toBe(1)

    expect((await c.del(`/api/uploads/${upload.id}`)).status).toBe(200)
    expect((await uploadRow(upload.id)).status).toBe('aborted')
    await expect(t.deps.storage.listParts(row.storageKey, row.s3UploadId)).rejects.toThrow()
    expect((await c.get(`/api/uploads/${upload.id}`)).body.upload.status).toBe('aborted')
    // No further parts or completion.
    expect((await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [1] })).status).toBe(409)
    expect((await c.post(`/api/uploads/${upload.id}/complete`)).status).toBe(409)
  })

  it('cannot abort a finished upload', async () => {
    const { c } = await signup(t)
    const { upload } = await fullUpload(c, small)
    expect((await c.del(`/api/uploads/${upload.id}`)).status).toBe(409)
  })

  it('after an abort the project takes a new upload', async () => {
    const { c } = await signup(t)
    const { projectId, upload } = await startUpload(c, small)
    await c.del(`/api/uploads/${upload.id}`)
    expect((await fullUpload(c, small, { projectId })).done.status).toBe(200)
  })
})

describe('expiry and cleanup', () => {
  const expire = (id: string) =>
    db()
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, id))

  it('an expired upload cannot take parts or finish, and says so', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1])
    await expire(upload.id)

    expect((await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [2] })).status).toBe(410)
    expect((await c.post(`/api/uploads/${upload.id}/complete`)).body.error.code).toBe(
      'UPLOAD_EXPIRED',
    )
    const state = await c.get(`/api/uploads/${upload.id}`)
    expect(state.body.upload.status).toBe('expired')
  })

  it('the sweep aborts expired uploads so storage stops holding their parts', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, multi)
    await putParts(c, upload, multi, [1])
    const row = await uploadRow(upload.id)
    await expire(upload.id)

    const result = await sweepUploads(t.deps, log)
    expect(result.expired).toBe(1)
    expect((await uploadRow(upload.id)).status).toBe('expired')
    await expect(t.deps.storage.listParts(row.storageKey, row.s3UploadId)).rejects.toThrow()
    // Running it again finds nothing more to do.
    expect((await sweepUploads(t.deps, log)).expired).toBe(0)
  })

  it('the sweep leaves live uploads alone', async () => {
    const { c } = await signup(t)
    const { upload } = await startUpload(c, small)
    expect(await sweepUploads(t.deps, log)).toEqual({
      expired: 0,
      stuck: 0,
      abandonedProjects: 0,
      unsubmittedReels: 0,
    })
    expect((await uploadRow(upload.id)).status).toBe('initiated')
  })

  it('the sweep removes a project that never got its video, but not a fresh one', async () => {
    const { c } = await signup(t)
    const old = (await c.post('/api/projects', { fileName: 'old.mp4' })).body.project
    const fresh = (await c.post('/api/projects', { fileName: 'fresh.mp4' })).body.project
    await db()
      .update(projects)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(projects.id, old.id))

    const result = await sweepUploads(t.deps, log)
    expect(result.abandonedProjects).toBe(1)
    expect((await c.get(`/api/projects/${old.id}`)).status).toBe(404)
    expect((await c.get(`/api/projects/${fresh.id}`)).status).toBe(200)
    expect(await db().select().from(jobs).where(eq(jobs.type, 'delete_project'))).toHaveLength(1)
  })

  it('the sweep keeps an old project whose upload is still in progress', async () => {
    const { c } = await signup(t)
    const { projectId } = await startUpload(c, small)
    await db()
      .update(projects)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(projects.id, projectId))
    expect((await sweepUploads(t.deps, log)).abandonedProjects).toBe(0)
    expect((await c.get(`/api/projects/${projectId}`)).status).toBe(200)
  })

  it('the sweep fails an upload stuck mid-completion and removes its file', async () => {
    const { c } = await signup(t)
    const { upload } = await fullUpload(c, small)
    // Pretend the server died after stitching the parts: a finished object, status stuck.
    const row = await uploadRow(upload.id)
    await t.deps.storage.putObject(row.storageKey, Buffer.from('orphan'))
    await db()
      .update(uploads)
      .set({ status: 'completing', updatedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(uploads.id, upload.id))

    const result = await sweepUploads(t.deps, log)
    expect(result.stuck).toBe(1)
    expect((await uploadRow(upload.id)).status).toBe('failed')
    expect(await t.deps.storage.head(row.storageKey)).toBeNull()
  })

  it('ids that do not exist are plain 404s', async () => {
    const { c } = await signup(t)
    expect((await c.get(`/api/uploads/${uuidv7()}`)).status).toBe(404)
    expect((await c.get('/api/uploads/nope')).status).toBe(404)
  })
})
