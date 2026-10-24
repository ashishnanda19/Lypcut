import { eq } from 'drizzle-orm'
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
} from '../../src/db/schema/index.js'
import { DEVELOPMENT_APP_SECRET } from '../../src/modules/privacy/routes.js'
import { signRequest } from '../../src/style/instagram/deletion.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { signup, type Person } from '../helpers/world.js'

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
const IG = '17841400000000001'

/** Meta calling the callback: no cookies, no Origin, a form with one field. */
const callback = (app: TestApp, signed: unknown) =>
  app.app.inject({
    method: 'POST',
    url: '/api/privacy/instagram/deletion',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload:
      signed === undefined
        ? ''
        : new URLSearchParams({ signed_request: String(signed) }).toString(),
  })
const metaSays = (userId: string, secret = DEVELOPMENT_APP_SECRET) =>
  signRequest({ user_id: userId }, secret)

/** A person with a connected account, Reels read from it, and one Reel of their own uploaded and analysed. */
async function withInstagramData(p: Person, igUserId = IG) {
  const [acc] = await db()
    .insert(instagramAccounts)
    .values({
      userId: p.id,
      igUserId,
      handle: '@me',
      accountType: 'creator',
      tokenEnvelope: t.deps.vault.seal('tok', p.id).envelope,
      keyId: 'dev',
      tokenExpiresAt: new Date(Date.now() + 50 * 86_400_000),
    })
    .returning()
  const fromIg = await db()
    .insert(reels)
    .values(
      [1, 2, 3].map((n) => ({
        userId: p.id,
        accountId: acc!.id,
        source: 'instagram' as const,
        externalId: `m${n}`,
        label: `Reel ${n}`,
        status: 'analysed' as const,
      })),
    )
    .returning()
  await db()
    .insert(reelMetrics)
    .values(
      fromIg.map((r) => ({
        reelId: r.id,
        origin: 'instagram' as const,
        views: 5000,
        saves: 100,
        shares: 50,
      })),
    )
  const [mine] = await db()
    .insert(reels)
    .values({ userId: p.id, source: 'upload', label: 'mine', status: 'analysed' })
    .returning()
  await db().insert(reelAnalysis).values({
    reelId: mine!.id,
    contentHash: 'h',
    algoVersion: 'v1',
    durationSec: 20,
    cutPace: 3,
    captionStyleId: 'boxed',
  })
  await db()
    .insert(reelMetrics)
    .values({ reelId: mine!.id, origin: 'upload', views: 900, saves: 40 })
  await db()
    .insert(styleProfiles)
    .values({
      userId: p.id,
      confidence: 'low',
      profile: {
        reelsAnalysed: 4,
        hookTimingSec: 2,
        cutPace: 5,
        captionStyles: [{ id: 'boxed', share: 1 }],
        music: [],
        hookRetention: [],
        fonts: [],
        colors: [],
        confidence: 'low',
      },
    })
  await db()
    .insert(oauthStates)
    .values({ userId: p.id, stateHash: `h-${p.id}`, expiresAt: new Date(Date.now() + 1000) })
  return { acc: acc!, fromIg, mine: mine! }
}

describe('the privacy policy', () => {
  it('is public, and says what is read, what is not, why, where it goes, how long it is kept and how to remove it', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/privacy' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    const text = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    for (const part of [
      'instagram_business_basic',
      'instagram_business_manage_insights',
      'never post, comment, message',
      'we do not download them',
      'followers',
      'encrypted',
      'never your handle, your token',
      'do not sell',
      'within 24 hours',
      'Apps and websites',
    ])
      expect(text, part).toContain(part)
  })

  it('names who it is and how to reach them from the settings, and cannot be made to carry markup', async () => {
    const custom = await createTestApp({
      LEGAL_ENTITY_NAME: 'Acme <b>Labs</b> Pvt Ltd',
      PRIVACY_CONTACT_EMAIL: 'privacy@acme.example',
    })
    try {
      const body = (await custom.app.inject({ method: 'GET', url: '/api/privacy' })).body
      expect(body).toContain('Acme &#60;b&#62;Labs&#60;/b&#62; Pvt Ltd')
      expect(body).not.toContain('<b>Labs')
      expect(body).toContain('mailto:privacy@acme.example')
    } finally {
      await custom.close()
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/privacy' })).body).toContain(
      '[set PRIVACY_CONTACT_EMAIL]',
    )
  })
})

describe('Meta’s data-deletion callback', () => {
  it('verifies the request, deletes the Instagram data of that account, and answers with a code and a status address', async () => {
    const p = await signup(t)
    const { mine } = await withInstagramData(p)
    const res = await callback(t, metaSays(IG))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confirmation_code).toMatch(/^[0-9a-f-]{36}$/)
    expect(new URL(body.url).search).toBe(`?code=${body.confirmation_code}`)
    expect(new URL(body.url).pathname).toBe('/api/privacy/instagram/deletion')

    // The connection (and the token with it), every Reel read from Instagram, their numbers and the pending sign-ins are gone.
    expect(await db().select().from(instagramAccounts)).toEqual([])
    expect((await db().select().from(reels)).map((r) => r.id)).toEqual([mine.id])
    expect((await db().select().from(reelMetrics)).map((m) => m.reelId)).toEqual([mine.id])
    expect(await db().select().from(oauthStates)).toEqual([])
    // The person's own uploaded Reel is theirs, not Instagram's: it stays, and the profile is worked out again from it alone.
    expect(await db().select().from(reelAnalysis)).toHaveLength(1)
    const [profile] = await db().select().from(styleProfiles)
    expect((profile!.profile as { reelsAnalysed: number }).reelsAnalysed).toBe(1)
    // Instagram is never stored as files, so there are no objects to remove.
    expect(await db().select().from(assets)).toEqual([])
    expect(await t.deps.storage.deletePrefix(`users/${p.id}/`)).toBe(0)
    expect(JSON.stringify(body)).not.toContain(p.id)
  })

  it('leaves nothing from Instagram in any table, for a person who had only Instagram', async () => {
    const p = await signup(t)
    await withInstagramData(p)
    await db().delete(reelAnalysis)
    await db().delete(reels).where(eq(reels.source, 'upload'))
    await db().delete(styleProfiles)
    expect((await callback(t, metaSays(IG))).statusCode).toBe(200)
    for (const table of [
      instagramAccounts,
      reels,
      reelMetrics,
      reelAnalysis,
      styleProfiles,
      oauthStates,
    ])
      expect(await db().select().from(table), String(table)).toEqual([])
    // A person with no Reels measured has no profile at all.
    expect((await (await signup(t)).c.get('/api/style')).body.connected).toBe(false)
  })

  it('is idempotent, and gives a code even for an account Lypcut has never heard of', async () => {
    const first = (await callback(t, metaSays('99999999999'))).json()
    expect(first.confirmation_code).toBeDefined()
    const p = await signup(t)
    await withInstagramData(p)
    expect((await callback(t, metaSays(IG))).statusCode).toBe(200)
    expect((await callback(t, metaSays(IG))).statusCode).toBe(200)
    expect(await db().select().from(instagramAccounts)).toEqual([])
  })

  it('applies to everyone connected to that Instagram account, and no one else', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const c = await signup(t)
    await withInstagramData(a)
    await withInstagramData(b)
    await withInstagramData(c, '17841400000000099')
    await callback(t, metaSays(IG))
    const left = await db().select().from(instagramAccounts)
    expect(left.map((x) => x.userId)).toEqual([c.id])
    expect(await db().select().from(reels).where(eq(reels.userId, c.id))).toHaveLength(4)
  })

  it('gives a status address that says it is done, and that is no way to look at anything else', async () => {
    const { confirmation_code } = (await callback(t, metaSays('42'))).json()
    const done = await t.app.inject({
      method: 'GET',
      url: `/api/privacy/instagram/deletion?code=${confirmation_code}`,
    })
    expect(done.json()).toEqual({ status: 'completed' })
    // Not a code that was given out: another kind of job, a made-up id, something that is not an id.
    const p = await signup(t)
    const [other] = await db()
      .insert(jobs)
      .values({ userId: p.id, type: 'style_analysis' })
      .returning()
    const [disconnect] = await db()
      .insert(jobs)
      .values({ type: 'style_deletion', detail: 'Removing style data' })
      .returning()
    for (const code of [
      other!.id,
      disconnect!.id,
      crypto.randomUUID(),
      'abc',
      '1; drop table jobs',
    ]) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/privacy/instagram/deletion?code=${encodeURIComponent(code)}`,
      })
      expect(res.statusCode, code).toBe(404)
      expect(res.json()).toEqual({ status: 'unknown' })
    }
  })

  it('rejects anything that is not exactly Meta’s signed request, does nothing, and gives no reason', async () => {
    const p = await signup(t)
    await withInstagramData(p)
    const good = metaSays(IG)
    const [sig, payload] = good.split('.') as [string, string]
    const forged = [
      metaSays(IG, 'someone-elses-secret'),
      `${sig}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: IG, extra: 1 })).toString('base64url')}`,
      `${sig.slice(0, -3)}AAA.${payload}`,
      signRequest({ user_id: IG, algorithm: 'none' }, DEVELOPMENT_APP_SECRET),
      `${sig}`,
      'not a signed request',
      '',
    ]
    for (const bad of forged) {
      const res = await callback(t, bad)
      expect(res.statusCode, bad.slice(0, 20)).toBe(403)
      expect(res.json().error.message).toBe('That request could not be verified.')
    }
    // No form at all, a JSON body, and a request with the field in the query.
    expect((await callback(t, undefined)).statusCode).toBe(403)
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/privacy/instagram/deletion',
          payload: { signed_request: good },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/privacy/instagram/deletion?signed_request=${good}`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: '',
        })
      ).statusCode,
    ).toBe(403)
    // Nothing was deleted, and no confirmation was made.
    expect(await db().select().from(instagramAccounts)).toHaveLength(1)
    expect(await db().select().from(reels)).toHaveLength(4)
    expect(await db().select().from(jobs)).toEqual([])
  })

  it('uses the Instagram app’s own secret when there is one, and then the development secret no longer works', async () => {
    const real = await createTestApp({
      INSTAGRAM_APP_ID: 'id',
      INSTAGRAM_APP_SECRET: 'the-real-secret',
      INSTAGRAM_REDIRECT_URI: 'https://api.example.com/api/style/callback',
    })
    try {
      expect((await callback(real, metaSays(IG))).statusCode).toBe(403)
      expect(
        (await callback(real, signRequest({ user_id: IG }, 'the-real-secret'))).statusCode,
      ).toBe(200)
      const body = (await callback(real, signRequest({ user_id: IG }, 'the-real-secret'))).json()
      expect(
        body.url.startsWith('https://api.example.com/api/privacy/instagram/deletion?code='),
      ).toBe(true)
    } finally {
      await real.close()
    }
  })

  it('is not offered in production without an Instagram app: there is no secret to verify with', async () => {
    const prod = await createTestApp({
      NODE_ENV: 'production',
      AUTH_ACCESS_SECRET: 'q7Zk2mV9xR4tLw8Hn3Yb6Pd1Gf5Sa0Jc',
      TOKEN_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
      COOKIE_SECURE: 'false',
    })
    try {
      expect((await callback(prod, metaSays(IG))).statusCode).toBe(501)
    } finally {
      await prod.close()
    }
  })
})
