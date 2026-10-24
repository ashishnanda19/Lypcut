import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assets,
  instagramAccounts,
  oauthStates,
  reelAnalysis,
  reelMetrics,
  reels,
  styleProfiles,
  users,
} from '../../src/db/schema/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { signup } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
})

const db = () => t.deps.database.db
const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
  await expect(p).rejects.toSatisfy((e: unknown) => {
    // Drizzle wraps the driver's error; the database's own message is on the cause.
    const text = [e, (e as { cause?: unknown })?.cause]
      .map((x) => String((x as Error)?.message ?? x))
      .join(' ')
    return pattern.test(text)
  })
}

async function account(userId: string, igUserId = 'ig-1') {
  const [row] = await db()
    .insert(instagramAccounts)
    .values({
      userId,
      igUserId,
      handle: '@creator',
      accountType: 'creator',
      tokenEnvelope: 'v1.dev.x.y',
      keyId: 'dev',
      tokenExpiresAt: new Date(Date.now() + 60 * 86400_000),
    })
    .returning()
  return row!
}

async function uploadedReel(userId: string, label = 'reel.mp4') {
  const [row] = await db().insert(reels).values({ userId, source: 'upload', label }).returning()
  return row!
}

describe('reels', () => {
  it('an Instagram Reel needs its account and its Instagram id; an upload needs neither', async () => {
    const { id } = await signup(t)
    const acc = await account(id)
    await rejects(
      db().insert(reels).values({ userId: id, source: 'instagram', label: 'x' }),
      /reels_source_shape/,
    )
    await rejects(
      db().insert(reels).values({ userId: id, source: 'instagram', accountId: acc.id, label: 'x' }),
      /reels_source_shape/,
    )
    await db()
      .insert(reels)
      .values({ userId: id, source: 'instagram', accountId: acc.id, externalId: 'm1', label: 'x' })
    await uploadedReel(id, 'a.mp4')
    await uploadedReel(id, 'b.mp4')
    expect(await db().select().from(reels).where(eq(reels.userId, id))).toHaveLength(3)
  })

  it('syncing the same Instagram Reel twice cannot make two rows', async () => {
    const { id } = await signup(t)
    const acc = await account(id)
    const reel = {
      userId: id,
      source: 'instagram' as const,
      accountId: acc.id,
      externalId: 'm1',
      label: 'x',
    }
    await db().insert(reels).values(reel)
    await rejects(db().insert(reels).values(reel), /reels_user_source_external_uq/)
    await db()
      .insert(reels)
      .values({ ...reel, externalId: 'm2' })
  })

  it('a Reel has to have a length, when it has one', async () => {
    const { id } = await signup(t)
    await rejects(
      db().insert(reels).values({ userId: id, source: 'upload', label: 'x', durationSec: 0 }),
      /reels_duration_positive/,
    )
  })
})

describe('metrics', () => {
  it('keeps a missing number as null, never as 0, and keeps every reading', async () => {
    const { id } = await signup(t)
    const reel = await uploadedReel(id)
    await db().insert(reelMetrics).values({ reelId: reel.id, origin: 'upload', views: 1200 })
    await db()
      .insert(reelMetrics)
      .values({
        reelId: reel.id,
        origin: 'upload',
        views: 1500,
        saves: 0,
        readAt: new Date(Date.now() + 1000),
      })
    const rows = await db().select().from(reelMetrics).where(eq(reelMetrics.reelId, reel.id))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      views: 1200,
      likes: null,
      saves: null,
      avgWatchPct: null,
      skipRate: null,
    })
    // A real zero is a different thing from not knowing.
    expect(rows.find((r) => r.views === 1500)?.saves).toBe(0)
  })

  it('refuses negative counts and percentages or rates out of range', async () => {
    const { id } = await signup(t)
    const reel = await uploadedReel(id)
    const base = { reelId: reel.id, origin: 'upload' as const }
    await rejects(
      db()
        .insert(reelMetrics)
        .values({ ...base, likes: -1 }),
      /reel_metrics_counts_nonneg/,
    )
    await rejects(
      db()
        .insert(reelMetrics)
        .values({ ...base, avgWatchPct: 101 }),
      /reel_metrics_ranges/,
    )
    await rejects(
      db()
        .insert(reelMetrics)
        .values({ ...base, avgWatchPct: -1 }),
      /reel_metrics_ranges/,
    )
    await rejects(
      db()
        .insert(reelMetrics)
        .values({ ...base, skipRate: 1.5 }),
      /reel_metrics_ranges/,
    )
    await rejects(
      db()
        .insert(reelMetrics)
        .values({ ...base, avgWatchSec: -2 }),
      /reel_metrics_ranges/,
    )
  })
})

describe('analysis', () => {
  const analysis = (reelId: string, over: Partial<typeof reelAnalysis.$inferInsert> = {}) => ({
    reelId,
    contentHash: 'h',
    algoVersion: 'v1',
    durationSec: 30,
    cutPace: 3.2,
    ...over,
  })

  it('is one row per Reel, with scores between 0 and 100', async () => {
    const { id } = await signup(t)
    const reel = await uploadedReel(id)
    await db()
      .insert(reelAnalysis)
      .values(analysis(reel.id, { hookTimingSec: 1.4, engagementScore: 72 }))
    await rejects(db().insert(reelAnalysis).values(analysis(reel.id)), /reel_analysis_reel_uq/)
    const other = await uploadedReel(id, 'other.mp4')
    await rejects(
      db()
        .insert(reelAnalysis)
        .values(analysis(other.id, { engagementScore: 101 })),
      /reel_analysis_ranges/,
    )
    await rejects(
      db()
        .insert(reelAnalysis)
        .values(analysis(other.id, { cutPace: -1 })),
      /reel_analysis_ranges/,
    )
  })
})

describe('accounts, profiles and sign-in states', () => {
  it('a person has one Instagram account and one profile', async () => {
    const { id } = await signup(t)
    await account(id)
    await rejects(account(id, 'ig-2'), /instagram_accounts_user_uq/)
    await db()
      .insert(styleProfiles)
      .values({ userId: id, profile: { cutPace: 3 }, confidence: 'low' })
    await rejects(
      db().insert(styleProfiles).values({ userId: id, profile: {}, confidence: 'high' }),
      /style_profiles_user_uq/,
    )
  })

  it('a sign-in state can be stored once; the same hash cannot be stored twice', async () => {
    const { id } = await signup(t)
    const row = { userId: id, stateHash: 'abc', expiresAt: new Date(Date.now() + 600_000) }
    await db().insert(oauthStates).values(row)
    await rejects(db().insert(oauthStates).values(row), /oauth_states_hash_uq/)
  })
})

describe('assets', () => {
  it('belong to a project or to a person, and cannot belong to nobody', async () => {
    const { id } = await signup(t)
    await db()
      .insert(assets)
      .values({ userId: id, kind: 'style_reel', storageKey: `users/${id}/style/a`, label: 'a' })
    await rejects(
      db()
        .insert(assets)
        .values({ kind: 'style_reel', storageKey: `users/${id}/style/b`, label: 'b' }),
      /assets_has_owner/,
    )
  })
})

describe('deleting a person', () => {
  it('removes every style row with them: accounts, Reels, numbers, analysis, profile, states and style files', async () => {
    const { id } = await signup(t)
    const other = await signup(t)
    const acc = await account(id)
    const reel = await uploadedReel(id)
    const [asset] = await db()
      .insert(assets)
      .values({ userId: id, kind: 'style_reel', storageKey: `users/${id}/style/x`, label: 'x' })
      .returning()
    await db().update(reels).set({ assetId: asset!.id }).where(eq(reels.id, reel.id))
    await db().insert(reelMetrics).values({ reelId: reel.id, origin: 'upload', views: 10 })
    await db()
      .insert(reelAnalysis)
      .values({ reelId: reel.id, contentHash: 'h', algoVersion: 'v1', durationSec: 20, cutPace: 2 })
    await db().insert(styleProfiles).values({ userId: id, profile: {}, confidence: 'low' })
    await db()
      .insert(oauthStates)
      .values({ userId: id, stateHash: 's', expiresAt: new Date(Date.now() + 1000) })
    const keep = await uploadedReel(other.id)
    expect(acc.userId).toBe(id)

    await db().delete(users).where(eq(users.id, id))

    const count = async (table: string) =>
      Number((await db().execute(sql.raw(`select count(*) as n from ${table}`))).rows[0]!.n)
    expect(await count('instagram_accounts')).toBe(0)
    expect(await count('reel_metrics')).toBe(0)
    expect(await count('reel_analysis')).toBe(0)
    expect(await count('style_profiles')).toBe(0)
    expect(await count('oauth_states')).toBe(0)
    expect(await count('assets')).toBe(0)
    // Someone else's Reel is not touched.
    expect((await db().select().from(reels)).map((r) => r.id)).toEqual([keep.id])
  })

  it('removing an Instagram account removes the Reels read from it, and not the uploaded ones', async () => {
    const { id } = await signup(t)
    const acc = await account(id)
    await db()
      .insert(reels)
      .values({ userId: id, source: 'instagram', accountId: acc.id, externalId: 'm1', label: 'x' })
    const mine = await uploadedReel(id)
    await db().delete(instagramAccounts).where(eq(instagramAccounts.id, acc.id))
    expect((await db().select().from(reels)).map((r) => r.id)).toEqual([mine.id])
  })
})
