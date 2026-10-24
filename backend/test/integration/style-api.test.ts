import fs from 'node:fs'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assets,
  instagramAccounts,
  jobs,
  oauthStates,
  reelAnalysis,
  reelMetrics,
  reels,
  styleProfiles,
  users,
} from '../../src/db/schema/index.js'
import { configureMedia } from '../../src/media/ffmpeg.js'
import { stylePrefix } from '../../src/lib/storage-keys.js'
import { processStyleJob } from '../../src/workers/style.js'
import { processMaintenanceJob } from '../../src/workers/maintenance.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { ScriptedProvider } from '../helpers/provider.js'
import { makeReel, wordsAt, type ReelSpec } from '../helpers/reel-video.js'
import { readyProject } from '../helpers/ready.js'
import { fullStyleUpload, startStyleUpload } from '../helpers/upload.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
const log = pino({ level: 'silent' })
beforeAll(async () => {
  configureMedia({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

const db = () => t.deps.database.db
const speech = () => new ScriptedProvider(() => ({ language: 'hi', words: wordsAt(1.5, 24, 3) }))

/** Uploads one Reel the way the page will and returns its id. */
async function upload(p: Person, spec: ReelSpec, fileName: string) {
  const { done } = await fullStyleUpload(p.c, await makeReel(spec), { fileName })
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.reel.id as string
}

/** The worker, run by hand: every queued style job for the person, in order. */
async function runJobs(userId: string, provider = speech()) {
  const queued = await db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.status, 'queued')))
  for (const j of queued.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
    await processStyleJob({ deps: t.deps, log }, provider, {
      data: { jobId: j.id },
      attemptsMade: 0,
    })
  return queued
}

const SPECS: Array<[ReelSpec, string, Record<string, number>]> = [
  [
    { seconds: 12, cuts: [2, 4, 6, 8, 10], look: 'saffron-pop' },
    'best.mp4',
    { views: 9000, likes: 800, saves: 700, shares: 500, avgWatchPct: 80 },
  ],
  [
    { seconds: 12, cuts: [3, 6, 9], look: 'saffron-pop' },
    'second.mp4',
    { views: 8000, likes: 700, saves: 600, shares: 420, avgWatchPct: 74 },
  ],
  [
    { seconds: 12, cuts: [6], look: 'plain' },
    'third.mp4',
    { views: 8000, likes: 300, saves: 30, shares: 20, avgWatchPct: 30 },
  ],
]

/** Three Reels uploaded, submitted with numbers, and analysed. */
async function learnedStyle(p: Person) {
  const ids: string[] = []
  for (const [spec, name] of SPECS) ids.push(await upload(p, spec, name))
  const submit = await p.c.post('/api/style/upload', {
    count: 3,
    metrics: [
      { reelId: ids[0], ...SPECS[0]![2] },
      { fileName: 'second.mp4', ...SPECS[1]![2] },
      { fileName: 'third', ...SPECS[2]![2] },
    ],
  })
  expect(submit.status, JSON.stringify(submit.body)).toBe(200)
  await runJobs(p.id)
  return ids
}

describe('before there is a style', () => {
  it('has a profile that says it is not connected, no Reels, and nothing going on', async () => {
    const { c } = await signup(t)
    const profile = await c.get('/api/style')
    expect(profile.status).toBe(200)
    expect(profile.body).toEqual({
      connected: false,
      source: null,
      reelsAnalysed: 0,
      hookTimingSec: 0,
      cutPace: 0,
      captionStyles: [],
      music: [],
      hookRetention: [],
      fonts: [],
      colors: [],
      confidence: 'low',
      updatedAt: null,
    })
    expect((await c.get('/api/style/reels')).body).toEqual([])
    expect((await c.get('/api/style/status')).body).toMatchObject({
      state: 'idle',
      progress: 0,
      reels: { total: 0 },
    })
  })

  it('needs a login, on every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/style'],
      ['GET', '/api/style/reels'],
      ['GET', '/api/style/status'],
      ['POST', '/api/style/upload'],
      ['DELETE', '/api/style/connect'],
      ['DELETE', `/api/style/reels/${crypto.randomUUID()}`],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        payload: method === 'POST' ? { count: 3 } : undefined,
      })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })
})

describe('learning from uploaded Reels', () => {
  it('uploads, submits with numbers, analyses, and then shows the profile and the Reels', async () => {
    const p = await signup(t)
    const ids: string[] = []
    for (const [spec, name] of SPECS) ids.push(await upload(p, spec, name))
    expect((await p.c.get('/api/style/status')).body).toMatchObject({
      state: 'idle',
      reels: { total: 3, pending: 3 },
    })

    const submit = await p.c.post('/api/style/upload', {
      count: 3,
      metrics: [
        { reelId: ids[0], ...SPECS[0]![2] },
        { fileName: 'second.mp4', ...SPECS[1]![2] },
        { fileName: 'third', ...SPECS[2]![2] },
      ],
    })
    // The answer is the profile as it is now: still nothing, because the learning has only just begun.
    expect(submit.status).toBe(200)
    expect(submit.body.connected).toBe(false)
    expect((await p.c.get('/api/style/status')).body).toMatchObject({
      state: 'analysing',
      reels: { analysing: 3 },
    })
    const [job] = await db().select().from(jobs).where(eq(jobs.userId, p.id))
    expect(job).toMatchObject({ type: 'style_analysis', status: 'queued' })

    await runJobs(p.id)
    expect((await p.c.get('/api/style/status')).body).toMatchObject({
      state: 'ready',
      progress: 100,
      reels: { analysed: 3, analysing: 0 },
      failed: [],
    })

    const profile = (await p.c.get('/api/style')).body
    expect(profile).toMatchObject({
      connected: true,
      source: 'upload',
      reelsAnalysed: 3,
      music: [],
      confidence: 'low',
    })
    expect(profile).not.toHaveProperty('handle')
    expect(profile.captionStyles[0]).toMatchObject({ id: 'saffron-pop' })
    expect(
      profile.captionStyles.reduce((n: number, s: { share: number }) => n + s.share, 0),
    ).toBeCloseTo(1, 10)
    expect(profile.cutPace).toBeGreaterThan(1)
    expect(profile.hookTimingSec).toBeCloseTo(1.5, 0)
    expect(profile.fonts).toEqual(['Inter'])
    expect(profile.summary).toMatch(/Your best Reels|Aapki best Reels/)
    expect(new Date(profile.updatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)

    const list = (await p.c.get('/api/style/reels')).body as Array<Record<string, unknown>>
    expect(list.map((r) => r.title)).toEqual(['best', 'second', 'third'])
    expect(list[0]).toMatchObject({
      id: ids[0],
      views: 9000,
      likes: 800,
      saves: 700,
      shares: 500,
      avgWatchPct: 80,
      comments: null,
      engagement: 100,
      source: 'upload',
    })
    expect(list[2]!.engagement).toBe(0)
    expect(list[0]!.durationSec).toBeCloseTo(12, 0)
    expect(typeof list[0]!.postedAt).toBe('string')
    expect(list[0]!.thumbSeed).toBe(ids[0])
  })

  it('keeps the numbers and a picture, and deletes the video once it has been analysed', async () => {
    const p = await signup(t)
    await learnedStyle(p)
    const rows = await db().select().from(reels).where(eq(reels.userId, p.id))
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.assetId).toBeNull()
      expect(r.thumbnailAssetId).not.toBeNull()
    }
    // No video is left in the database or in storage; the pictures are.
    expect(
      await db()
        .select()
        .from(assets)
        .where(and(eq(assets.userId, p.id), eq(assets.kind, 'style_reel'))),
    ).toEqual([])
    const kept = await db().select().from(assets).where(eq(assets.userId, p.id))
    expect(kept).toHaveLength(3)
    expect(kept.every((a) => a.kind === 'thumbnail')).toBe(true)
    const keys = await t.deps.storage.deletePrefix('users/nothing-here/')
    expect(keys).toBe(0)
    for (const a of kept)
      expect((await t.deps.storage.head(a.storageKey))?.contentType).toBe('image/jpeg')
    expect(await db().select().from(reelMetrics)).toHaveLength(3)
    expect(await db().select().from(reelAnalysis)).toHaveLength(3)

    // The picture can be fetched with the short-lived link.
    const list = (await p.c.get('/api/style/reels')).body as Array<{ thumbUrl?: string }>
    const res = await fetch(list[0]!.thumbUrl!)
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type')).toMatch(/image\/jpeg/)
  })

  it('learns from Reels with no numbers too, and shows the numbers as unknown, not zero', async () => {
    const p = await signup(t)
    for (const [spec, name] of SPECS) await upload(p, spec, name)
    expect((await p.c.post('/api/style/upload', { count: 3 })).status).toBe(200)
    await runJobs(p.id)
    const list = (await p.c.get('/api/style/reels')).body as Array<Record<string, unknown>>
    expect(list).toHaveLength(3)
    for (const r of list)
      expect(r).toMatchObject({
        views: null,
        likes: null,
        saves: null,
        shares: null,
        avgWatchPct: null,
        engagement: null,
      })
    expect((await p.c.get('/api/style')).body).toMatchObject({
      connected: true,
      confidence: 'low',
      reelsAnalysed: 3,
    })
  })

  it('waits for Reels still uploading, and has nothing to do when none are waiting', async () => {
    const p = await signup(t)
    expect((await p.c.post('/api/style/upload', { count: 3 })).body.error.message).toMatch(
      /Upload your Reels first/,
    )
    await upload(p, SPECS[0]![0], 'one.mp4')
    const early = await p.c.post('/api/style/upload', { count: 3 })
    expect(early.status).toBe(409)
    expect(early.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { uploaded: 1, expected: 3 },
    })
    // Nothing started, and the Reel is still waiting.
    expect(await db().select().from(jobs).where(eq(jobs.userId, p.id))).toEqual([])
    expect((await p.c.post('/api/style/upload', { count: 1 })).status).toBe(200)
  })

  it('refuses numbers that are not valid, for a Reel that is not theirs, or given twice', async () => {
    const p = await signup(t)
    const other = await signup(t)
    const ids = [await upload(p, SPECS[0]![0], 'a.mp4'), await upload(p, SPECS[1]![0], 'b.mp4')]
    const theirs = await upload(other, SPECS[2]![0], 'c.mp4')
    const post = (body: unknown) => p.c.post('/api/style/upload', body)
    expect((await post({ count: 2, metrics: [{ reelId: ids[0], views: -5 }] })).status).toBe(422)
    expect((await post({ count: 2, metrics: [{ reelId: ids[0], avgWatchPct: 120 }] })).status).toBe(
      422,
    )
    expect((await post({ count: 2, metrics: [{ reelId: ids[0], views: 1.5 }] })).status).toBe(422)
    expect((await post({ count: 2, metrics: [{ views: 10 }] })).status).toBe(422)
    expect((await post({ count: 2, metrics: [{ reelId: ids[0], followers: 10 }] })).status).toBe(
      422,
    )
    expect((await post({ count: 0 })).status).toBe(422)
    expect((await post({ count: 11 })).status).toBe(422)
    expect((await post({ count: 2, metrics: [{ reelId: theirs, views: 10 }] })).status).toBe(422)
    expect(
      (await post({ count: 2, metrics: [{ fileName: 'missing.mp4', views: 10 }] })).status,
    ).toBe(422)
    expect(
      (
        await post({
          count: 2,
          metrics: [
            { reelId: ids[0], views: 10 },
            { fileName: 'a.mp4', views: 20 },
          ],
        })
      ).status,
    ).toBe(422)
    // None of those started anything or stored any number.
    expect(await db().select().from(jobs).where(eq(jobs.userId, p.id))).toEqual([])
    expect(await db().select().from(reelMetrics)).toEqual([])
    expect((await post({ count: 2, metrics: [{ reelId: ids[0], views: 10 }] })).status).toBe(200)
  })

  it('says which Reel could not be analysed and why, and still learns from the rest', async () => {
    const p = await signup(t)
    const ids: string[] = []
    for (const [spec, name] of SPECS) ids.push(await upload(p, spec, name))
    // Something went wrong with one file after it was accepted.
    const [asset] = await db()
      .select()
      .from(assets)
      .where(
        eq(assets.id, (await db().select().from(reels).where(eq(reels.id, ids[2]!)))[0]!.assetId!),
      )
    await t.deps.storage.putObject(
      asset!.storageKey,
      Buffer.from('not a video '.repeat(300)),
      'video/mp4',
    )
    await p.c.post('/api/style/upload', { count: 3 })
    await runJobs(p.id)
    const status = (await p.c.get('/api/style/status')).body
    expect(status).toMatchObject({ state: 'ready', reels: { analysed: 2, failed: 1 } })
    expect(status.failed).toEqual([
      {
        id: ids[2],
        label: 'third',
        code: 'unreadable',
        message: expect.stringMatching(/could not read this file/),
      },
    ])
    expect((await p.c.get('/api/style')).body.reelsAnalysed).toBe(2)
    expect(((await p.c.get('/api/style/reels')).body as unknown[]).length).toBe(2)
    // The bad file is not kept either.
    expect((await db().select().from(reels).where(eq(reels.id, ids[2]!)))[0]!.assetId).toBeNull()
  })

  it('reports a job that gave up as failed rather than analysing for ever', async () => {
    const p = await signup(t)
    await upload(p, SPECS[0]![0], 'a.mp4')
    await p.c.post('/api/style/upload', { count: 1 })
    await db().update(jobs).set({ status: 'failed', error: 'x' }).where(eq(jobs.userId, p.id))
    expect((await p.c.get('/api/style/status')).body.state).toBe('failed')
  })

  it('removes a Reel nobody submitted after a day, with its video', async () => {
    const p = await signup(t)
    await upload(p, SPECS[0]![0], 'forgotten.mp4')
    const [asset] = await db().select().from(assets).where(eq(assets.userId, p.id))
    expect(await t.deps.storage.head(asset!.storageKey)).not.toBeNull()
    const { StyleService } = await import('../../src/modules/style/service.js')
    const service = new StyleService(t.deps, log)
    expect(await service.sweepUnsubmitted(new Date(), 24 * 3600_000)).toBe(0)
    expect(await service.sweepUnsubmitted(new Date(Date.now() + 25 * 3600_000))).toBe(1)
    expect(await t.deps.storage.head(asset!.storageKey)).toBeNull()
    expect(await db().select().from(reels).where(eq(reels.userId, p.id))).toEqual([])
    expect(await db().select().from(assets).where(eq(assets.userId, p.id))).toEqual([])
  })
})

describe('removing one Reel', () => {
  it('removes it, its numbers, its picture and works the profile out again', async () => {
    const p = await signup(t)
    const ids = await learnedStyle(p)
    const [removed] = await db().select().from(reels).where(eq(reels.id, ids[2]!))
    const [thumb] = await db()
      .select()
      .from(assets)
      .where(eq(assets.id, removed!.thumbnailAssetId!))
    expect(await t.deps.storage.head(thumb!.storageKey)).not.toBeNull()
    const del = await p.c.del(`/api/style/reels/${ids[2]}`)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    expect((await p.c.get('/api/style')).body.reelsAnalysed).toBe(2)
    expect(
      ((await p.c.get('/api/style/reels')).body as Array<{ id: string }>).map((r) => r.id),
    ).toEqual([ids[0], ids[1]])
    expect(await db().select().from(assets).where(eq(assets.userId, p.id))).toHaveLength(2)
    expect(await t.deps.storage.head(thumb!.storageKey)).toBeNull()
    // Removing the last one leaves no profile.
    await p.c.del(`/api/style/reels/${ids[0]}`)
    await p.c.del(`/api/style/reels/${ids[1]}`)
    expect((await p.c.get('/api/style')).body.connected).toBe(false)
    expect(await db().select().from(styleProfiles)).toEqual([])
  })

  it('makes room under the ten Reel limit', async () => {
    const p = await signup(t)
    const rows = await db()
      .insert(reels)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          userId: p.id,
          source: 'upload' as const,
          label: `r${i}`,
        })),
      )
      .returning()
    const file = await makeReel({ seconds: 8, look: 'none' })
    expect((await startStyleUpload(p.c, file)).res.status).toBe(403)
    expect((await p.c.del(`/api/style/reels/${rows[0]!.id}`)).status).toBe(200)
    expect((await startStyleUpload(p.c, file)).res.status).toBe(201)
  })
})

describe('disconnecting', () => {
  it('removes every row Style holds for the person before it answers, and the files in a job that logs when it is done', async () => {
    const p = await signup(t)
    await readyProject(t, p, { content: true, fitTimeline: true })
    await learnedStyle(p)
    // One Reel uploaded but not submitted, one upload still in flight, a pending sign-in and a connected account.
    await upload(p, SPECS[0]![0], 'waiting.mp4')
    await startStyleUpload(p.c, await makeReel({ seconds: 8, look: 'none' }), {
      fileName: 'midway.mp4',
    })
    await db()
      .insert(oauthStates)
      .values({ userId: p.id, stateHash: 'h', expiresAt: new Date(Date.now() + 1000) })
    await db()
      .insert(instagramAccounts)
      .values({
        userId: p.id,
        igUserId: 'ig',
        handle: '@me',
        accountType: 'creator',
        tokenEnvelope: 'v1.dev.a.b',
        keyId: 'dev',
        tokenExpiresAt: new Date(Date.now() + 1e9),
      })
    expect((await p.c.get('/api/style')).body).toMatchObject({ source: 'instagram', handle: '@me' })

    const res = await p.c.del('/api/style/connect')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      connected: false,
      source: null,
      reelsAnalysed: 0,
      captionStyles: [],
    })

    // Every table that holds anything about their style is empty for them.
    const mine = { reels, reelAnalysis, reelMetrics, styleProfiles, oauthStates, instagramAccounts }
    expect(await db().select().from(reels).where(eq(reels.userId, p.id))).toEqual([])
    expect(await db().select().from(reelAnalysis)).toEqual([])
    expect(await db().select().from(reelMetrics)).toEqual([])
    expect(await db().select().from(styleProfiles)).toEqual([])
    expect(await db().select().from(oauthStates)).toEqual([])
    expect(await db().select().from(instagramAccounts)).toEqual([])
    expect(Object.keys(mine)).toHaveLength(6)
    expect(
      await db()
        .select()
        .from(assets)
        .where(and(eq(assets.userId, p.id), isNull(assets.projectId))),
    ).toEqual([])

    // Their project is not touched.
    expect(await db().select().from(assets).where(eq(assets.kind, 'raw'))).toHaveLength(1)

    // The files go in a job that is already waiting, and it aborts the half-sent upload too.
    const [job] = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, p.id), eq(jobs.type, 'style_deletion')))
    expect(job).toMatchObject({ status: 'queued', payload: { prefix: stylePrefix(p.id) } })
    expect((job!.payload as { uploads: unknown[] }).uploads).toHaveLength(1)
    const half = (job!.payload as { uploads: Array<{ key: string; uploadId: string }> }).uploads[0]!
    expect(half.key.startsWith(stylePrefix(p.id))).toBe(true)
    await expect(t.deps.storage.listParts(half.key, half.uploadId)).resolves.toBeDefined()
    await processStyleJob({ deps: t.deps, log }, speech(), {
      data: { jobId: job!.id },
      attemptsMade: 0,
    })
    expect((await db().select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({
      status: 'done',
      progress: 100,
    })
    await expect(t.deps.storage.listParts(half.key, half.uploadId)).rejects.toBeDefined()
    // Nothing of theirs is left in the style folder.
    expect(await t.deps.storage.deletePrefix(stylePrefix(p.id))).toBe(0)
    expect((await p.c.get('/api/style/status')).body).toMatchObject({
      state: 'idle',
      reels: { total: 0 },
    })
  })

  it('does nothing to anyone else’s data, and can be done twice', async () => {
    const a = await signup(t)
    const b = await signup(t)
    await learnedStyle(a)
    await learnedStyle(b)
    expect((await a.c.del('/api/style/connect')).status).toBe(200)
    expect((await a.c.del('/api/style/connect')).status).toBe(200)
    await runJobs(a.id)
    expect((await b.c.get('/api/style')).body).toMatchObject({ connected: true, reelsAnalysed: 3 })
    expect(((await b.c.get('/api/style/reels')).body as unknown[]).length).toBe(3)
    expect((await t.deps.storage.deletePrefix(stylePrefix(b.id))) > 0).toBe(true)
  })

  it('refuses a job that names anything but a person’s style folder', async () => {
    const { id } = await signup(t)
    for (const prefix of ['users/', `users/${id}/`, `users/${id}/projects/`, 'users/../style/']) {
      const [job] = await db()
        .insert(jobs)
        .values({ userId: id, type: 'style_deletion', payload: { prefix } })
        .returning()
      await expect(
        processStyleJob({ deps: t.deps, log }, speech(), {
          data: { jobId: job!.id },
          attemptsMade: 0,
        }),
      ).rejects.toThrow(/refusing/)
    }
  })

  it('deleting the account removes the style files too', async () => {
    const p = await signup(t)
    await learnedStyle(p)
    await upload(p, SPECS[0]![0], 'waiting.mp4')
    const files = await db().select().from(assets).where(eq(assets.userId, p.id))
    expect(files.length).toBeGreaterThan(0)
    const res = await p.c.request('DELETE', '/api/me', { password: 'correct-horse-battery' })
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    const [job] = await db().select().from(jobs).where(eq(jobs.type, 'delete_account'))
    await processMaintenanceJob({ deps: t.deps, log }, {
      data: { jobId: job!.id },
      name: 'delete_account',
      attemptsMade: 0,
    } as never)
    expect(await db().select().from(reels)).toEqual([])
    for (const f of files) expect(await t.deps.storage.head(f.storageKey)).toBeNull()
    expect(await db().select().from(users).where(eq(users.id, p.id))).toEqual([])
  })
})

describe('one person cannot reach another’s Style', () => {
  it('sees only their own profile, Reels and status, and cannot remove the other’s Reel', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const aIds = await learnedStyle(a)
    await learnedStyle(b)
    const mine = (await a.c.get('/api/style/reels')).body as Array<{ id: string }>
    expect(mine.map((r) => r.id).sort()).toEqual([...aIds].sort())
    const bList = (await b.c.get('/api/style/reels')).body as Array<{ id: string }>
    expect(bList.some((r) => aIds.includes(r.id))).toBe(false)

    const theirs = await a.c.del(`/api/style/reels/${bList[0]!.id}`)
    const imaginary = await a.c.del(`/api/style/reels/${crypto.randomUUID()}`)
    expect(theirs.status).toBe(404)
    expect(theirs.body).toEqual(imaginary.body)
    expect((await a.c.del('/api/style/reels/not-an-id')).status).toBe(404)
    expect(((await b.c.get('/api/style/reels')).body as unknown[]).length).toBe(3)
    expect((await a.c.get('/api/style/status')).body.reels.total).toBe(3)
    // Submitting does not touch the other person's waiting Reels.
    const waiting = await upload(b, SPECS[0]![0], 'b-waiting.mp4')
    expect((await a.c.post('/api/style/upload', { count: 1 })).status).toBe(409)
    expect((await db().select().from(reels).where(eq(reels.id, waiting)))[0]!.status).toBe(
      'pending',
    )
  })
})

describe('no response ever contains a token', () => {
  it('holds for the profile, the Reels and the status of someone with a connected account', async () => {
    const p = await signup(t)
    await learnedStyle(p)
    const secret = 'IGAA-super-secret-access-token-value'
    const { envelope } = t.deps.vault.seal(secret, p.id)
    await db()
      .insert(instagramAccounts)
      .values({
        userId: p.id,
        igUserId: 'ig-1',
        handle: '@creator',
        accountType: 'creator',
        tokenEnvelope: envelope,
        keyId: t.deps.vault.currentKeyId,
        tokenExpiresAt: new Date(Date.now() + 1e9),
      })
    for (const url of ['/api/style', '/api/style/reels', '/api/style/status', '/api/me']) {
      const res = await p.c.get(url)
      const text = JSON.stringify(res.body)
      expect(text, url).not.toContain(secret)
      expect(text, url).not.toContain(envelope)
      expect(text, url).not.toMatch(/tokenEnvelope|token_envelope|keyId/)
    }
    expect((await p.c.get('/api/style')).body).toMatchObject({
      source: 'instagram',
      handle: '@creator',
    })
  })
})

describe('the shapes the front end reads', () => {
  const types = path.resolve(import.meta.dirname, '../../../frontend/src/types/index.ts')
  const fields = (name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
      fs.readFileSync(types, 'utf8'),
    )![1]!
    return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!)
  }

  it.skipIf(!fs.existsSync(types))(
    'every field of StyleProfile and ReelMetric is in the responses',
    async () => {
      const p = await signup(t)
      await learnedStyle(p)
      const profile = (await p.c.get('/api/style')).body
      for (const f of fields('StyleProfile').filter((x) => x !== 'handle'))
        expect(profile, f).toHaveProperty(f)
      const [reel] = (await p.c.get('/api/style/reels')).body
      for (const f of fields('ReelMetric')) expect(reel, f).toHaveProperty(f)
      const empty = (await (await signup(t)).c.get('/api/style')).body
      for (const f of fields('StyleProfile').filter((x) => x !== 'handle'))
        expect(empty, f).toHaveProperty(f)
    },
  )

  it.skipIf(!fs.existsSync(types))(
    'ReelMetric and StyleProfile have not gained a field the server does not send',
    () => {
      expect(fields('StyleProfile').sort()).toEqual(
        [
          'captionStyles',
          'colors',
          'connected',
          'cutPace',
          'fonts',
          'handle',
          'hookRetention',
          'hookTimingSec',
          'music',
          'reelsAnalysed',
          'source',
        ].sort(),
      )
      expect(fields('ReelMetric').sort()).toEqual(
        [
          'avgWatchPct',
          'durationSec',
          'id',
          'likes',
          'postedAt',
          'saves',
          'shares',
          'thumbSeed',
          'title',
          'views',
        ].sort(),
      )
    },
  )
})
