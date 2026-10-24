import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  instagramAccounts,
  jobs,
  reelAnalysis,
  reelMetrics,
  reels,
  styleProfiles,
} from '../../src/db/schema/index.js'
import { InstagramError } from '../../src/style/instagram/client.js'
import type { FakeInstagramClient } from '../../src/style/instagram/fake.js'
import { InstagramSync } from '../../src/style/jobs/sync.js'
import { scheduleRefreshes, scheduleSyncs } from '../../src/style/jobs/schedule.js'
import { processMaintenanceJob } from '../../src/workers/maintenance.js'
import { processStyleJob } from '../../src/workers/style.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { ScriptedProvider } from '../helpers/provider.js'
import { makeReel, wordsAt } from '../helpers/reel-video.js'
import { configureMedia } from '../../src/media/ffmpeg.js'
import { fullStyleUpload } from '../helpers/upload.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
const log = pino({ level: 'silent' })
beforeAll(async () => {
  configureMedia({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  t = await createTestApp({ STYLE_IG_CALL_INTERVAL_MS: '300' })
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
  const ig = fake()
  ig.calls.length = 0
  for (const m of [ig.script.failNext, ig.script.failAlways]) m.clear()
  ig.script.revoked.clear()
  ig.script.notReels.clear()
  ig.script.reels = 14
})

const db = () => t.deps.database.db
const fake = () => t.deps.instagram as FakeInstagramClient
const speech = () => new ScriptedProvider(() => ({ language: 'hi', words: wordsAt(1.5, 24, 3) }))
const DAY = 86_400_000

/** A connected account, as the callback leaves it, with a token that opens for this person. */
async function connected(
  p: Person,
  o: {
    expiresInDays?: number
    refreshedDaysAgo?: number | null
    createdDaysAgo?: number
    lastSyncDaysAgo?: number | null
  } = {},
) {
  const token = `fake-long:17841400000000001:1`
  const sealed = t.deps.vault.seal(token, p.id)
  const [acc] = await db()
    .insert(instagramAccounts)
    .values({
      userId: p.id,
      igUserId: '17841400000000001',
      handle: '@aarav.builds',
      accountType: 'creator',
      tokenEnvelope: sealed.envelope,
      keyId: sealed.keyId,
      tokenExpiresAt: new Date(Date.now() + (o.expiresInDays ?? 50) * DAY),
      tokenRefreshedAt: o.refreshedDaysAgo ? new Date(Date.now() - o.refreshedDaysAgo * DAY) : null,
      lastSyncAt: o.lastSyncDaysAgo == null ? null : new Date(Date.now() - o.lastSyncDaysAgo * DAY),
      createdAt: new Date(Date.now() - (o.createdDaysAgo ?? 5) * DAY),
    })
    .returning()
  return acc!
}

const sleeps: number[] = []
const syncer = (now?: () => Date) =>
  new InstagramSync(t.deps, log, fake(), { sleep: async (ms) => void sleeps.push(ms), now })
const accountOf = async (p: Person) =>
  (await db().select().from(instagramAccounts).where(eq(instagramAccounts.userId, p.id)))[0]!
beforeEach(() => void (sleeps.length = 0))

describe('reading the Reels', () => {
  it('stores each Reel once, with its date and its numbers as they were read, and nothing else about it', async () => {
    const p = await signup(t)
    const acc = await connected(p)
    const r = await syncer().sync(p.id, speech())
    expect(r).toMatchObject({ listed: 14, read: 14 })

    const rows = await db().select().from(reels).where(eq(reels.userId, p.id))
    expect(rows).toHaveLength(14)
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'instagram',
        accountId: acc.id,
        status: 'analysed',
        assetId: null,
        thumbnailAssetId: null,
        durationSec: null,
      })
      expect(row.externalId).toMatch(/^fake_17841400000000001_\d+$/)
      expect(row.label).toMatch(/^Reel · \d{1,2} \w{3} 20\d\d$/)
      expect(row.postedAt).toBeInstanceOf(Date)
    }
    const metrics = await db().select().from(reelMetrics)
    expect(metrics).toHaveLength(14)
    for (const m of metrics) {
      expect(m.origin).toBe('instagram')
      expect(m.views).toBeGreaterThan(0)
      expect(m.avgWatchSec).toBeGreaterThan(0)
      // Instagram's average watch time is a time, not a share: without the Reel's length there is no percentage to invent.
      expect(m.avgWatchPct).toBeNull()
    }
    expect((await accountOf(p)).lastSyncAt).not.toBeNull()
  })

  it('is safe to run twice: no Reel is duplicated, and a reading is not repeated seconds later, but is added later on', async () => {
    const p = await signup(t)
    await connected(p)
    await syncer().sync(p.id, speech())
    const second = await syncer().sync(p.id, speech())
    expect(second).toMatchObject({ listed: 14, read: 0 })
    expect(await db().select().from(reels)).toHaveLength(14)
    expect(await db().select().from(reelMetrics)).toHaveLength(14)
    // A week later every Reel is read again, and the earlier readings are kept.
    const later = await syncer(() => new Date(Date.now() + 7 * DAY)).sync(p.id, speech())
    expect(later.read).toBe(14)
    expect(await db().select().from(reels)).toHaveLength(14)
    expect(await db().select().from(reelMetrics)).toHaveLength(28)
  })

  it('goes at a steady pace, one call to Instagram at a time with a pause between', async () => {
    const p = await signup(t)
    await connected(p)
    await syncer().sync(p.id, speech())
    expect(sleeps.filter((s) => s === 300)).toHaveLength(13)
    expect(fake().calls.filter((c) => c === 'insights')).toHaveLength(14)
    expect(fake().calls.filter((c) => c === 'listMedia')).toHaveLength(1)
  })

  it('ignores media that is not a Reel, and forgets Reels that are no longer among the newest or are gone', async () => {
    const p = await signup(t)
    await connected(p)
    fake().script.notReels.add('fake_17841400000000001_3')
    await syncer().sync(p.id, speech())
    expect((await db().select().from(reels)).map((r) => r.externalId)).not.toContain(
      'fake_17841400000000001_3',
    )
    expect(await db().select().from(reels)).toHaveLength(13)
    fake().script.reels = 8
    await syncer(() => new Date(Date.now() + DAY)).sync(p.id, speech())
    const left = await db().select().from(reels)
    expect(left).toHaveLength(7)
    expect(
      await db()
        .select()
        .from(reelMetrics)
        .then((m) => m.length),
    ).toBe(7 + 7)
  })

  it('keeps no more than the newest few the settings allow', async () => {
    const small = await createTestApp({ STYLE_MAX_REELS: '5', STYLE_IG_CALL_INTERVAL_MS: '0' })
    try {
      const p = await signup(small)
      const token = small.deps.vault.seal('fake-long:17841400000000001:1', p.id)
      await small.deps.database.db.insert(instagramAccounts).values({
        userId: p.id,
        igUserId: '17841400000000001',
        handle: '@a',
        accountType: 'creator',
        tokenEnvelope: token.envelope,
        keyId: token.keyId,
        tokenExpiresAt: new Date(Date.now() + 50 * DAY),
      })
      await new InstagramSync(small.deps, log, small.deps.instagram!, {
        sleep: async () => undefined,
      }).sync(p.id, speech())
      expect(await small.deps.database.db.select().from(reels)).toHaveLength(5)
    } finally {
      await small.close()
    }
  })

  it('ranks them against each other: the Reels appear in the list with a score, best first', async () => {
    const p = await signup(t)
    await connected(p)
    await syncer().sync(p.id, speech())
    const list = (await p.c.get('/api/style/reels')).body as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(list).toHaveLength(14)
    expect(list.every((r) => r.source === 'instagram')).toBe(true)
    // Ranked on several signals at once, so no Reel need be best at all of them: the top is high and the bottom low.
    expect(list[0]!.engagement).toBeGreaterThan(80)
    expect(list.at(-1)!.engagement).toBeLessThan(20)
    for (let i = 1; i < list.length; i++)
      expect(list[i - 1]!.engagement).toBeGreaterThanOrEqual(list[i]!.engagement)
    expect(list[0]).toMatchObject({
      comments: expect.any(Number),
      avgWatchPct: null,
      durationSec: 0,
    })
    expect(JSON.stringify(list)).not.toMatch(/caption|username|handle/i)
  })

  it('on its own does not make a style: it needs the videos, and the status says so', async () => {
    const p = await signup(t)
    await connected(p)
    await syncer().sync(p.id, speech())
    expect(await db().select().from(styleProfiles)).toEqual([])
    expect((await p.c.get('/api/style/status')).body).toMatchObject({
      state: 'idle',
      needs: 'reel_files',
    })
    expect((await p.c.get('/api/style')).body).toMatchObject({
      connected: true,
      source: 'instagram',
      handle: '@aarav.builds',
      reelsAnalysed: 0,
    })

    // Upload a Reel's file, and it is learned from, ranked along with the Instagram ones.
    const { done } = await fullStyleUpload(
      p.c,
      await makeReel({ seconds: 12, cuts: [3, 6, 9], look: 'saffron-pop' }),
      { fileName: 'mine.mp4' },
    )
    expect((await p.c.post('/api/style/upload', { count: 1 })).status).toBe(200)
    const [job] = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, p.id), eq(jobs.type, 'style_analysis')))
    await processStyleJob({ deps: t.deps, log }, speech(), {
      data: { jobId: job!.id },
      attemptsMade: 0,
    })
    expect(done.status).toBe(200)
    expect((await p.c.get('/api/style/status')).body).toMatchObject({ state: 'ready', needs: null })
    expect((await p.c.get('/api/style')).body).toMatchObject({
      reelsAnalysed: 1,
      captionStyles: [{ id: 'saffron-pop', share: 1 }],
    })
    expect(await db().select().from(reelAnalysis)).toHaveLength(1)
  })
})

describe('when Instagram is slow or fails', () => {
  it('waits as long as it is told to and carries on', async () => {
    const p = await signup(t)
    await connected(p)
    fake().script.failNext.set('insights', new InstagramError('rate_limited', 30))
    const r = await syncer().sync(p.id, speech())
    expect(r.read).toBe(14)
    expect(sleeps.some((ms) => ms >= 30_000 && ms <= 36_100)).toBe(true)
  })

  it('backs off from a brief outage, and gives up, for the queue to retry later, if it goes on', async () => {
    const p = await signup(t)
    await connected(p)
    fake().script.failNext.set('listMedia', new InstagramError('unavailable'))
    expect((await syncer().sync(p.id, speech())).listed).toBe(14)
    expect(sleeps.some((ms) => ms >= 1000 && ms <= 1300)).toBe(true)

    fake().script.failAlways.set('listMedia', new InstagramError('rate_limited', 5))
    await expect(syncer().sync(p.id, speech())).rejects.toMatchObject({ kind: 'rate_limited' })
    // Four tries (after the two of the first sync), three waits, and the account is still fine: this is a pause, not a problem with the connection.
    expect(fake().calls.filter((c) => c === 'listMedia')).toHaveLength(2 + 4)
    const acc = await accountOf(p)
    expect(acc).toMatchObject({ status: 'active', lastError: 'rate_limited' })
  })

  it('slows down by itself when Instagram says most of its allowance is used', async () => {
    const p = await signup(t)
    await connected(p)
    ;(fake() as { usagePercent: number }).usagePercent = 90
    try {
      await syncer().sync(p.id, speech())
      expect(sleeps.filter((ms) => ms === 5000).length).toBeGreaterThan(5)
    } finally {
      ;(fake() as { usagePercent: number }).usagePercent = 0
    }
  })

  it('a token that no longer works stops the reading, marks the account as needing to be connected again, and the editor is unaffected', async () => {
    const p = await signup(t)
    await connected(p)
    await syncer().sync(p.id, speech())
    const before = await db().select().from(reels)
    fake().script.revoked.add('17841400000000001')
    const r = await syncer(() => new Date(Date.now() + DAY)).sync(p.id, speech())
    expect(r.reauthRequired).toBe(true)
    expect(await accountOf(p)).toMatchObject({
      status: 'reauth_required',
      lastError: 'token_invalid',
    })
    // What was read before is still shown.
    expect(await db().select().from(reels)).toHaveLength(before.length)
    expect((await p.c.get('/api/style/status')).body.state).toBe('reauth_required')
    expect(((await p.c.get('/api/style/reels')).body as unknown[]).length).toBe(14)
    expect((await p.c.get('/api/style')).status).toBe(200)

    // Nothing more is asked of Instagram until they connect again, and a manual refresh says so.
    fake().calls.length = 0
    expect(await syncer().sync(p.id, speech())).toMatchObject({ listed: 0, reauthRequired: true })
    expect(fake().calls).toEqual([])
    const manual = await p.c.post('/api/style/sync')
    expect(manual.status).toBe(409)
    expect(manual.body.error.message).toMatch(/Connect again/)
  })
})

describe('keeping the token alive', () => {
  it('renews it for another 60 days, sealed again, when it is a day old and getting near its end', async () => {
    const p = await signup(t)
    const acc = await connected(p, { expiresInDays: 5, createdDaysAgo: 55 })
    expect(await syncer().refreshToken(p.id)).toEqual({ refreshed: true })
    const after = await accountOf(p)
    expect(after.tokenEnvelope).not.toBe(acc.tokenEnvelope)
    expect(t.deps.vault.open(after.tokenEnvelope, p.id)).toMatch(
      /^fake-long:17841400000000001:\d+$/,
    )
    expect((after.tokenExpiresAt.getTime() - Date.now()) / DAY).toBeGreaterThan(59)
    expect(after.tokenRefreshedAt).not.toBeNull()
    expect(after.status).toBe('active')
  })

  it('does not try to renew a token under a day old, which Instagram would refuse', async () => {
    const p = await signup(t)
    await connected(p, { expiresInDays: 59.9, createdDaysAgo: 0.2 })
    expect(await syncer().refreshToken(p.id)).toEqual({ refreshed: false })
    expect(fake().calls).toEqual([])
    const other = await signup(t)
    await connected(other, { expiresInDays: 5, createdDaysAgo: 55, refreshedDaysAgo: 0.3 })
    expect(await syncer().refreshToken(other.id)).toEqual({ refreshed: false })
  })

  it('marks an account whose token has run out as needing to be connected again: it can no longer be renewed', async () => {
    const p = await signup(t)
    await connected(p, { expiresInDays: -1, createdDaysAgo: 61 })
    expect(await syncer().refreshToken(p.id)).toEqual({ refreshed: false, reauthRequired: true })
    expect(await accountOf(p)).toMatchObject({ status: 'reauth_required' })
    expect(fake().calls).toEqual([])
  })

  it('marks it too when Instagram refuses to renew, but only pauses when Instagram is down', async () => {
    const a = await signup(t)
    await connected(a, { expiresInDays: 5, createdDaysAgo: 55 })
    fake().script.revoked.add('17841400000000001')
    expect(await syncer().refreshToken(a.id)).toEqual({ refreshed: false, reauthRequired: true })
    expect((await accountOf(a)).status).toBe('reauth_required')

    fake().script.revoked.clear()
    const b = await signup(t)
    await connected(b, { expiresInDays: 5, createdDaysAgo: 55 })
    fake().script.failAlways.set('refresh', new InstagramError('unavailable'))
    await expect(syncer().refreshToken(b.id)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(await accountOf(b)).toMatchObject({ status: 'active', lastError: 'unavailable' })
  })
})

describe('the daily and weekly work', () => {
  it('reads every account that has not been read for six days, and no one else, and never twice at once', async () => {
    const [never, old, fresh, broken, nobody] = [
      await signup(t),
      await signup(t),
      await signup(t),
      await signup(t),
      await signup(t),
    ]
    await connected(never)
    await connected(old, { lastSyncDaysAgo: 8 })
    await connected(fresh, { lastSyncDaysAgo: 2 })
    await connected(broken, { lastSyncDaysAgo: 30 })
    await db()
      .update(instagramAccounts)
      .set({ status: 'reauth_required' })
      .where(eq(instagramAccounts.userId, broken.id))
    expect(nobody.id).toBeDefined()
    expect(await scheduleSyncs(t.deps, log)).toBe(2)
    const queued = await db().select().from(jobs).where(eq(jobs.type, 'style_sync'))
    expect(queued.map((j) => j.userId).sort()).toEqual([never.id, old.id].sort())
    expect(queued.every((j) => j.status === 'queued')).toBe(true)
    expect(await scheduleSyncs(t.deps, log)).toBe(0)
  })

  it('renews the tokens that are near their end, and marks the ones that have run out', async () => {
    const [soon, later, gone] = [await signup(t), await signup(t), await signup(t)]
    await connected(soon, { expiresInDays: 6, createdDaysAgo: 54 })
    await connected(later, { expiresInDays: 40 })
    await connected(gone, { expiresInDays: -2, createdDaysAgo: 62 })
    expect(await scheduleRefreshes(t.deps, log)).toEqual({ queued: 1, expired: 1 })
    expect(
      (await db().select().from(jobs).where(eq(jobs.type, 'style_refresh'))).map((j) => j.userId),
    ).toEqual([soon.id])
    expect((await accountOf(gone)).status).toBe('reauth_required')
    expect((await accountOf(later)).status).toBe('active')
    expect(await scheduleRefreshes(t.deps, log)).toEqual({ queued: 0, expired: 0 })
  })

  it('runs from the maintenance worker, on its schedule', async () => {
    const p = await signup(t)
    await connected(p)
    const ctx = { deps: t.deps, log }
    expect(
      await processMaintenanceJob(ctx, {
        name: 'style-weekly',
        data: { jobId: 'style-weekly' },
        attemptsMade: 0,
      } as never),
    ).toEqual({ queued: 1 })
    expect(
      await processMaintenanceJob(ctx, {
        name: 'style-refresh',
        data: { jobId: 'style-refresh' },
        attemptsMade: 0,
      } as never),
    ).toEqual({ queued: 0, expired: 0 })
  })
})

describe('the style worker’s Instagram jobs', () => {
  it('runs a sync and a renewal and records what they did', async () => {
    const p = await signup(t)
    await connected(p, { expiresInDays: 5, createdDaysAgo: 55 })
    const ctx = { deps: t.deps, log }
    const [sync] = await db().insert(jobs).values({ userId: p.id, type: 'style_sync' }).returning()
    expect(
      await processStyleJob(ctx, speech(), { data: { jobId: sync!.id }, attemptsMade: 0 }),
    ).toMatchObject({ listed: 14, read: 14 })
    expect((await db().select().from(jobs).where(eq(jobs.id, sync!.id)))[0]).toMatchObject({
      status: 'done',
      progress: 100,
    })
    const [refresh] = await db()
      .insert(jobs)
      .values({ userId: p.id, type: 'style_refresh' })
      .returning()
    expect(
      await processStyleJob(ctx, speech(), { data: { jobId: refresh!.id }, attemptsMade: 0 }),
    ).toEqual({ refreshed: true })
  })

  it('does nothing, and says so, when Instagram is not set up on the server', async () => {
    const p = await signup(t)
    const original = t.deps.instagram
    ;(t.deps as { instagram: unknown }).instagram = null
    try {
      const [job] = await db().insert(jobs).values({ userId: p.id, type: 'style_sync' }).returning()
      expect(
        await processStyleJob({ deps: t.deps, log }, speech(), {
          data: { jobId: job!.id },
          attemptsMade: 0,
        }),
      ).toEqual({ skipped: 'instagram is not set up' })
    } finally {
      ;(t.deps as { instagram: unknown }).instagram = original
    }
  })
})

describe('refreshing by hand', () => {
  it('needs a connected account, and answers 202 with the job', async () => {
    const p = await signup(t)
    const none = await p.c.post('/api/style/sync')
    expect(none.status).toBe(409)
    expect(none.body.error.message).toMatch(/Connect Instagram first/)
    await connected(p)
    const res = await p.c.post('/api/style/sync')
    expect(res.status).toBe(202)
    const [job] = await db().select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({ type: 'style_sync', userId: p.id, status: 'queued' })
  })

  it('answers with the one already running instead of starting another, and allows one an hour', async () => {
    const p = await signup(t)
    await connected(p)
    const first = await p.c.post('/api/style/sync')
    expect((await p.c.post('/api/style/sync')).body.jobId).toBe(first.body.jobId)
    await db().update(jobs).set({ status: 'done' }).where(eq(jobs.id, first.body.jobId))
    const limited = await p.c.post('/api/style/sync')
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(limited.body.error.details.retryAfterSec).toBeGreaterThan(3500)
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(3600)
    await db()
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 3601_000) })
      .where(eq(jobs.id, first.body.jobId))
    const again = await p.c.post('/api/style/sync')
    expect(again.status).toBe(202)
    expect(again.body.jobId).not.toBe(first.body.jobId)
  })

  it('is about their own account only', async () => {
    const a = await signup(t)
    const b = await signup(t)
    await connected(b)
    expect((await a.c.post('/api/style/sync')).status).toBe(409)
    expect(await db().select().from(jobs).where(eq(jobs.type, 'style_sync'))).toEqual([])
    expect((await a.c.get('/api/style')).body).toMatchObject({ connected: false })
    expect(((await a.c.get('/api/style/reels')).body as unknown[]).length).toBe(0)
  })
})
