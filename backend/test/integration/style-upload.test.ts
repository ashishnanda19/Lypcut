import fs from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assets, projects, reels, uploads, usageEvents } from '../../src/db/schema/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeReel } from '../helpers/reel-video.js'
import { makeVideo } from '../helpers/media.js'
import { fullStyleUpload, putParts, startStyleUpload } from '../helpers/upload.js'
import { signup } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

const db = () => t.deps.database.db

describe('uploading a Reel for style learning', () => {
  it('uses the same resumable upload, with no project, and ends as a Reel waiting to be submitted', async () => {
    const { c, id } = await signup(t)
    const file = await makeReel({ seconds: 10, look: 'none' })
    const { upload, res } = await startStyleUpload(c, file, { fileName: 'My Reel.mp4' })
    expect(res.status).toBe(201)
    expect(res.body.upload).toMatchObject({
      projectId: null,
      fileName: 'My Reel.mp4',
      status: 'initiated',
    })

    await putParts(c, upload, file)
    const done = await c.post(`/api/uploads/${upload.id}/complete`, {})
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.upload).toMatchObject({ status: 'completed', projectId: null })
    expect(done.body.reel).toMatchObject({ label: 'My Reel' })
    expect(done.body.reel.durationSec).toBeCloseTo(10, 0)
    expect(done.body).not.toHaveProperty('project')
    expect(done.body).not.toHaveProperty('job')

    // A style Reel is a file that belongs to the person, under their style folder: never a project.
    const [asset] = await db().select().from(assets).where(eq(assets.userId, id))
    expect(asset).toMatchObject({ kind: 'style_reel', projectId: null, status: 'ready' })
    expect(asset!.storageKey.startsWith(`users/${id}/style/reels/`)).toBe(true)
    expect(await db().select().from(projects)).toEqual([])
    const [reel] = await db().select().from(reels).where(eq(reels.userId, id))
    expect(reel).toMatchObject({ source: 'upload', status: 'pending', assetId: asset!.id })
    // The file is verified by its content: it was probed, so its length is known.
    expect(asset!.durationSec).toBeCloseTo(10, 0)
    // Finishing it again gives the same Reel.
    const again = await c.post(`/api/uploads/${upload.id}/complete`, {})
    expect(again.body.reel.id).toBe(reel!.id)
  })

  it('does not count against the monthly project uploads or video minutes', async () => {
    const { c, id } = await signup(t)
    const file = await makeReel({ seconds: 8, look: 'none' })
    for (let i = 0; i < 4; i++)
      expect((await fullStyleUpload(c, file, { fileName: `r${i}.mp4` })).done.status).toBe(200)
    expect(await db().select().from(usageEvents).where(eq(usageEvents.userId, id))).toEqual([])
    // The free plan's three project uploads a month are all still there.
    const project = await c.post('/api/projects', { fileName: 'talk.mp4' })
    expect(project.status).toBe(201)
  })

  it('verifies the checksum when one is sent', async () => {
    const { c } = await signup(t)
    const file = await makeReel({ seconds: 8, look: 'none' })
    const { sha256Stream } = await import('../../src/lib/hash.js')
    const hash = await sha256Stream(fs.createReadStream(file))
    expect((await fullStyleUpload(c, file, { checksum: hash })).done.status).toBe(200)
    const bad = await fullStyleUpload(c, file, { fileName: 'b.mp4', checksum: 'a'.repeat(64) })
    expect(bad.done.status).toBe(422)
    expect(bad.done.body.error.code).toBe('CHECKSUM_MISMATCH')
  })

  it('resumes when the same file is started again, instead of making a second upload', async () => {
    const { c } = await signup(t)
    const file = await makeReel({ seconds: 8, look: 'none' })
    const a = await startStyleUpload(c, file)
    const b = await startStyleUpload(c, file)
    expect(a.res.status).toBe(201)
    expect(b.res.status).toBe(200)
    expect(b.upload.id).toBe(a.upload.id)
  })

  it('limits a person to ten Reels, counting those still uploading, and says how to make room', async () => {
    const { c, id } = await signup(t)
    await db()
      .insert(reels)
      .values(
        Array.from({ length: 9 }, (_, i) => ({
          userId: id,
          source: 'upload' as const,
          label: `r${i}`,
        })),
      )
    const file = await makeReel({ seconds: 8, look: 'none' })
    const tenth = await startStyleUpload(c, file, { fileName: 'tenth.mp4' })
    expect(tenth.res.status).toBe(201)
    const eleventh = await startStyleUpload(c, file, { fileName: 'eleventh.mp4' })
    expect(eleventh.res.status).toBe(403)
    expect(eleventh.res.body.error).toMatchObject({
      code: 'LIMIT_STYLE_REELS',
      details: { max: 10 },
    })
    expect(eleventh.res.body.error.message).toMatch(/Remove one/)
  })

  it('refuses a Reel over 90 seconds, early from what the browser says and finally from the file', async () => {
    const { c, id } = await signup(t)
    const early = await startStyleUpload(c, await makeReel({ seconds: 8, look: 'none' }), {
      durationSec: 120,
    })
    expect(early.res.status).toBe(403)
    expect(early.res.body.error).toMatchObject({
      code: 'LIMIT_REEL_LENGTH',
      details: { maxSeconds: 90 },
    })

    // The browser said nothing, or lied: the file is measured.
    const long = await makeVideo({ seconds: 95, audio: false })
    const { done, upload } = await fullStyleUpload(c, long, { durationSec: 30 })
    expect(done.status).toBe(403)
    expect(done.body.error.code).toBe('LIMIT_REEL_LENGTH')
    const [row] = await db().select().from(uploads).where(eq(uploads.id, upload.id))
    expect(row!.status).toBe('failed')
    // Nothing is left behind: the file is gone and no Reel was made.
    expect(await t.deps.storage.head(row!.storageKey)).toBeNull()
    expect(await db().select().from(reels).where(eq(reels.userId, id))).toEqual([])
  })

  it('refuses a file that is not a video, by looking inside it, and one of the wrong kind', async () => {
    const { c } = await signup(t)
    const junk = `${process.env.TMPDIR ?? '/tmp'}/style-junk-${Date.now()}.mp4`
    fs.writeFileSync(junk, Buffer.from('definitely not a video'.repeat(500)))
    const { done } = await fullStyleUpload(c, junk)
    fs.rmSync(junk)
    expect(done.status).toBe(415)
    expect(done.body.error.code).toBe('UNSUPPORTED_MEDIA')
    const wrongType = await startStyleUpload(c, await makeReel({ seconds: 8, look: 'none' }), {
      fileName: 'notes.txt',
    })
    expect(wrongType.res.status).toBe(415)
  })

  it('refuses a file larger than the limit before any of it is sent', async () => {
    const small = await createTestApp({ STYLE_MAX_REEL_BYTES: '1000000' })
    try {
      const { c } = await signup(small)
      const res = await startStyleUpload(
        c,
        await makeVideo({ seconds: 8, audio: false, padToBytes: 2_000_000 }),
      )
      expect(res.res.status).toBe(413)
    } finally {
      await small.close()
    }
  })

  it('needs either a project or purpose style_reel, not both and not neither', async () => {
    const { c } = await signup(t)
    const base = { fileName: 'a.mp4', sizeBytes: 1000 }
    expect((await c.post('/api/uploads', base)).status).toBe(422)
    const project = (await c.post('/api/projects', { fileName: 'a.mp4' })).body.project.id as string
    expect(
      (await c.post('/api/uploads', { ...base, projectId: project, purpose: 'style_reel' })).status,
    ).toBe(422)
    expect((await c.post('/api/uploads', { ...base, projectId: project })).status).toBe(201)
  })

  it('keeps one person’s style uploads away from another’s, and from the other’s Reel count', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const file = await makeReel({ seconds: 8, look: 'none' })
    const { upload } = await startStyleUpload(a.c, file)
    expect((await b.c.get(`/api/uploads/${upload.id}`)).status).toBe(404)
    expect((await b.c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: [1] })).status).toBe(
      404,
    )
    expect((await b.c.post(`/api/uploads/${upload.id}/complete`, {})).status).toBe(404)
    expect((await b.c.request('DELETE', `/api/uploads/${upload.id}`)).status).toBe(404)
    await db()
      .insert(reels)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          userId: a.id,
          source: 'upload' as const,
          label: `r${i}`,
        })),
      )
    expect((await startStyleUpload(b.c, file)).res.status).toBe(201)
  })

  it('a project upload still works exactly as before', async () => {
    const { c } = await signup(t)
    const file = await makeReel({ seconds: 8, look: 'none' })
    const project = (await c.post('/api/projects', { fileName: 'talk.mp4' })).body.project
      .id as string
    const start = await c.post('/api/uploads', {
      projectId: project,
      fileName: 'talk.mp4',
      contentType: 'video/mp4',
      sizeBytes: fs.statSync(file).size,
    })
    expect(start.status).toBe(201)
    expect(start.body.upload.projectId).toBe(project)
    await putParts(c, start.body.upload, file)
    const done = await c.post(`/api/uploads/${start.body.upload.id}/complete`, {})
    expect(done.status).toBe(200)
    expect(done.body.project.id).toBe(project)
    expect(done.body.job.kind).toBe('processing')
    expect(
      await db()
        .select()
        .from(assets)
        .where(and(eq(assets.projectId, project), eq(assets.kind, 'raw'))),
    ).toHaveLength(1)
    expect(await db().select().from(assets).where(isNull(assets.projectId))).toEqual([])
  })
})
