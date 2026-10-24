import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { instagramAccounts, jobs, oauthStates, reels } from '../../src/db/schema/index.js'
import type { FakeInstagramClient } from '../../src/style/instagram/fake.js'
import { InstagramError } from '../../src/style/instagram/client.js'
import { InstagramOAuth, STATE_TTL_MS } from '../../src/style/instagram/oauth.js'
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
  const ig = fake()
  ig.calls.length = 0
  ig.script.failNext.clear()
  ig.script.failAlways.clear()
  ig.script.revoked.clear()
})

const db = () => t.deps.database.db
const fake = () => t.deps.instagram as FakeInstagramClient
const stateOf = (authUrl: string) => new URL(authUrl, 'http://x').searchParams.get('state')!
const APP = 'http://localhost:5173/app/style'

async function begin(p: Person) {
  const res = await p.c.post('/api/style/connect')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { res, state: stateOf(res.body.authUrl) }
}
/** The browser coming back from Instagram, as the person who started (their cookies go with it). */
async function comeBack(p: Person, query: string) {
  return p.c.get(`/api/style/callback?${query}`)
}
const where = (res: { headers: Record<string, unknown> }) => String(res.headers.location)

describe('starting to connect', () => {
  it('needs a login, and answers with where to send the person and what to tell them first', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/style/connect' })).statusCode).toBe(401)
    const p = await signup(t)
    const { res, state } = await begin(p)
    expect(res.body.authUrl).toContain('/api/style/fake-instagram/authorize')
    expect(res.body.scopes).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_insights',
    ])
    expect(res.body.consent.reads.join(' ')).toMatch(/Reels/)
    expect(res.body.consent.uses).toMatch(/learns your style/)
    expect(res.body.consent.never.join(' ')).toMatch(/Post, comment, message/)
    expect(res.body.consent.disconnect).toMatch(/24 hours/)
    expect(state.length).toBeGreaterThanOrEqual(43)
  })

  it('stores only the hash of the state, tied to the person, for ten minutes', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const [row] = await db().select().from(oauthStates).where(eq(oauthStates.userId, p.id))
    expect(row!.stateHash).toBe(createHash('sha256').update(state).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(state)
    expect(row!.usedAt).toBeNull()
    const lifetime = row!.expiresAt.getTime() - Date.now()
    expect(lifetime).toBeGreaterThan(STATE_TTL_MS - 15_000)
    expect(lifetime).toBeLessThanOrEqual(STATE_TTL_MS)
  })

  it('gives every sign-in its own state, and keeps only a few open at once', async () => {
    const p = await signup(t)
    const seen = new Set<string>()
    for (let i = 0; i < 8; i++) seen.add((await begin(p)).state)
    expect(seen.size).toBe(8)
    expect(await db().select().from(oauthStates).where(eq(oauthStates.userId, p.id))).toHaveLength(
      5,
    )
  })
})

describe('the stand-in consent screen', () => {
  it('offers a Creator, a Business and a personal account, and cancel, each carrying the state back', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const page = await t.app.inject({
      method: 'GET',
      url: `/api/style/fake-instagram/authorize?state=${state}`,
    })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    for (const code of ['fake-creator', 'fake-business', 'fake-personal'])
      expect(page.body).toContain(`/api/style/callback?code=${code}&#38;state=${state}`)
    expect(page.body).toContain('error=access_denied')
  })

  it('does not let a crafted state turn into markup', async () => {
    const page = await t.app.inject({
      method: 'GET',
      url: `/api/style/fake-instagram/authorize?state=${encodeURIComponent('"><script>alert(1)</script>')}`,
    })
    expect(page.body).not.toContain('<script')
    expect(page.body).toContain('%3Cscript%3E')
  })
})

describe('coming back from Instagram', () => {
  it('connects a Creator account: the token is sealed, the account is stored, a first read is queued, and the person lands on the Style page', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const res = await comeBack(p, `code=fake-creator&state=${state}`)
    expect(res.status).toBe(302)
    expect(where(res)).toBe(`${APP}?connected=1`)

    const [acc] = await db()
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.userId, p.id))
    expect(acc).toMatchObject({
      handle: '@aarav.builds',
      accountType: 'creator',
      status: 'active',
      keyId: 'dev',
      igUserId: '17841400000000001',
    })
    expect(acc!.scopes).toEqual(['instagram_business_basic', 'instagram_business_manage_insights'])
    // Sealed, and opens only for this person.
    expect(acc!.tokenEnvelope).toMatch(/^v1\.dev\./)
    expect(acc!.tokenEnvelope).not.toContain('fake-long')
    expect(t.deps.vault.open(acc!.tokenEnvelope, p.id)).toMatch(/^fake-long:17841400000000001:/)
    expect(() => t.deps.vault.open(acc!.tokenEnvelope, 'someone-else')).toThrow()
    const days = (acc!.tokenExpiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(59)
    expect(days).toBeLessThan(61)

    const [job] = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, p.id), eq(jobs.type, 'style_sync')))
    expect(job).toMatchObject({ status: 'queued' })
    expect((await p.c.get('/api/style')).body).toMatchObject({
      connected: true,
      source: 'instagram',
      handle: '@aarav.builds',
    })
  })

  it('connects a Business account too', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    expect(where(await comeBack(p, `code=fake-business&state=${state}`))).toBe(`${APP}?connected=1`)
    expect((await db().select().from(instagramAccounts))[0]!.accountType).toBe('business')
  })

  it('stops at a personal account, stores nothing, and says why', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const res = await comeBack(p, `code=fake-personal&state=${state}`)
    expect(where(res)).toBe(`${APP}?connected=0&reason=not_professional_account`)
    expect(await db().select().from(instagramAccounts)).toEqual([])
    expect(await db().select().from(jobs).where(eq(jobs.type, 'style_sync'))).toEqual([])
    expect(await db().select().from(reels)).toEqual([])
    // The sign-in is spent: it cannot be tried again.
    expect(where(await comeBack(p, `code=fake-creator&state=${state}`))).toContain(
      'reason=invalid_state',
    )
  })

  it('treats cancelling on Instagram as a refusal, without asking Instagram for anything', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const res = await comeBack(p, `error=access_denied&error_reason=user_denied&state=${state}`)
    expect(where(res)).toBe(`${APP}?connected=0&reason=denied`)
    expect(fake().calls).toEqual([])
    expect(await db().select().from(instagramAccounts)).toEqual([])
  })

  it('works only once: a second visit with the same state is refused before Instagram is asked anything', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    await comeBack(p, `code=fake-creator&state=${state}`)
    fake().calls.length = 0
    expect(where(await comeBack(p, `code=fake-creator&state=${state}`))).toContain(
      'reason=invalid_state',
    )
    expect(fake().calls).toEqual([])
  })

  it('is refused with no state, a made-up state, or a state that has expired, and asks Instagram nothing', async () => {
    const p = await signup(t)
    expect(where(await comeBack(p, 'code=fake-creator'))).toContain('reason=invalid_state')
    expect(where(await comeBack(p, 'code=fake-creator&state=made-up'))).toContain(
      'reason=invalid_state',
    )
    expect(where(await comeBack(p, 'error=access_denied&state=made-up'))).toContain(
      'reason=invalid_state',
    )
    const { state } = await begin(p)
    await db()
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
    expect(where(await comeBack(p, `code=fake-creator&state=${state}`))).toContain(
      'reason=invalid_state',
    )
    expect(fake().calls).toEqual([])
    expect(await db().select().from(instagramAccounts)).toEqual([])
  })

  it('belongs to whoever started it: another login cannot finish it', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const { state } = await begin(a)
    // B's browser arrives with A's state.
    const res = await comeBack(b, `code=fake-creator&state=${state}`)
    expect(where(res)).toContain('reason=invalid_state')
    expect(await db().select().from(instagramAccounts)).toEqual([])
    // And it is spent, so A cannot use it afterwards either: a fresh sign-in is needed.
    expect(where(await comeBack(a, `code=fake-creator&state=${state}`))).toContain(
      'reason=invalid_state',
    )
  })

  it('does not need a session of its own: the browser arrives from another site, and the state is what binds it to the person', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/style/callback?code=fake-creator&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${APP}?connected=1`)
    expect((await db().select().from(instagramAccounts))[0]!.userId).toBe(p.id)
  })

  it('always goes back to the configured address: a address in the request is ignored', async () => {
    const p = await signup(t)
    const { state } = await begin(p)
    const res = await comeBack(
      p,
      `code=fake-creator&state=${state}&redirect_uri=https://evil.example/x&next=https://evil.example&redirect=//evil.example`,
    )
    expect(where(res)).toBe(`${APP}?connected=1`)
    const q = await begin(p)
    expect(
      where(
        await comeBack(p, `error=access_denied&state=${q.state}&redirect_uri=https://evil.example`),
      ),
    ).toBe(`${APP}?connected=0&reason=denied`)
  })

  it('says so when Instagram cannot be reached or refuses the code, and stores nothing', async () => {
    const p = await signup(t)
    fake().script.failNext.set('exchangeCode', new InstagramError('unavailable'))
    expect(where(await comeBack(p, `code=fake-creator&state=${(await begin(p)).state}`))).toBe(
      `${APP}?connected=0&reason=unavailable`,
    )
    expect(where(await comeBack(p, `code=not-a-code&state=${(await begin(p)).state}`))).toBe(
      `${APP}?connected=0&reason=exchange_failed`,
    )
    fake().script.failNext.set('profile', new InstagramError('rate_limited', 60))
    expect(where(await comeBack(p, `code=fake-creator&state=${(await begin(p)).state}`))).toContain(
      'reason=unavailable',
    )
    expect(await db().select().from(instagramAccounts)).toEqual([])
  })

  it('refuses a connection where fewer permissions were approved than are needed', async () => {
    const p = await signup(t)
    const original = fake().exchangeCode.bind(fake())
    fake().exchangeCode = async (code) => ({
      ...(await original(code)),
      scopes: ['instagram_business_basic'],
    })
    try {
      expect(
        where(await comeBack(p, `code=fake-creator&state=${(await begin(p)).state}`)),
      ).toContain('reason=permission_denied')
    } finally {
      fake().exchangeCode = original
    }
    expect(await db().select().from(instagramAccounts)).toEqual([])
  })

  it('connecting again replaces the token and clears a "connect again" state; a different account starts fresh', async () => {
    const p = await signup(t)
    await comeBack(p, `code=fake-creator&state=${(await begin(p)).state}`)
    const [first] = await db().select().from(instagramAccounts)
    await db()
      .update(instagramAccounts)
      .set({ status: 'reauth_required', lastError: 'token_invalid' })
    await db().insert(reels).values({
      userId: p.id,
      accountId: first!.id,
      source: 'instagram',
      externalId: 'old',
      label: 'old',
    })
    await comeBack(p, `code=fake-creator&state=${(await begin(p)).state}`)
    const [again] = await db().select().from(instagramAccounts)
    expect(again).toMatchObject({ id: first!.id, status: 'active', lastError: null })
    expect(again!.tokenEnvelope).not.toBe(first!.tokenEnvelope)
    expect(await db().select().from(reels)).toHaveLength(1)

    await comeBack(p, `code=fake-business&state=${(await begin(p)).state}`)
    const accounts = await db().select().from(instagramAccounts)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ handle: '@lypcut.shop' })
    expect(accounts[0]!.id).not.toBe(first!.id)
    expect(await db().select().from(reels)).toEqual([])
  })
})

describe('no token, code or state in anything the API says or logs', () => {
  it('never appears in a response', async () => {
    const p = await signup(t)
    const { state, res } = await begin(p)
    const cb = await comeBack(p, `code=fake-creator&state=${state}`)
    const [acc] = await db().select().from(instagramAccounts)
    const token = t.deps.vault.open(acc!.tokenEnvelope, p.id)
    const bodies = [
      JSON.stringify(res.body),
      JSON.stringify(cb.headers),
      JSON.stringify((await p.c.get('/api/style')).body),
      JSON.stringify((await p.c.get('/api/style/status')).body),
      JSON.stringify((await p.c.get('/api/style/reels')).body),
      JSON.stringify((await p.c.get('/api/me')).body),
    ]
    for (const b of bodies)
      for (const leak of [token, acc!.tokenEnvelope, 'fake-short', 'fake-long'])
        expect(b).not.toContain(leak)
  })

  it('never appears in the logs of the sign-in or of a failed one', async () => {
    const lines: string[] = []
    const log = pino(
      { level: 'trace' },
      new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }),
    )
    const oauth = new InstagramOAuth(t.deps, log, fake())
    const p = await signup(t)
    const start = await oauth.start(p.id)
    const state = stateOf(start.authUrl)
    expect(await oauth.callback({ code: 'fake-creator', state }, p.id)).toEqual({ ok: true })
    const second = await oauth.start(p.id)
    await oauth.callback({ code: 'fake-personal', state: stateOf(second.authUrl) }, p.id)
    fake().script.failNext.set('exchangeCode', new InstagramError('unavailable'))
    const third = await oauth.start(p.id)
    await oauth.callback({ code: 'fake-creator', state: stateOf(third.authUrl) }, p.id)
    await oauth.callback({ code: 'x', state: 'wrong-state-value' }, p.id)
    const [acc] = await db().select().from(instagramAccounts)
    const token = t.deps.vault.open(acc!.tokenEnvelope, p.id)
    const text = lines.join('')
    expect(text.length).toBeGreaterThan(0)
    for (const leak of [
      token,
      'fake-short',
      'fake-long',
      state,
      stateOf(second.authUrl),
      'wrong-state-value',
      'fake-creator',
      acc!.tokenEnvelope,
    ])
      expect(text).not.toContain(leak)
  })
})

describe('when Instagram is not set up', () => {
  it('in production without a Meta app it is not offered: no connect, no stand-in page, manual upload unaffected', async () => {
    const prod = await createTestApp({
      NODE_ENV: 'production',
      AUTH_ACCESS_SECRET: 'q7Zk2mV9xR4tLw8Hn3Yb6Pd1Gf5Sa0Jc',
      TOKEN_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
      COOKIE_SECURE: 'false',
    })
    try {
      expect(prod.deps.instagram).toBeNull()
      const p = await signup(prod)
      const connect = await p.c.post('/api/style/connect')
      expect(connect.status).toBe(501)
      expect(connect.body.error.message).toMatch(/upload your Reels instead/)
      expect(
        (
          await prod.app.inject({
            method: 'GET',
            url: '/api/style/fake-instagram/authorize?state=x',
          })
        ).statusCode,
      ).toBe(404)
      expect((await p.c.get('/api/style')).status).toBe(200)
      expect((await p.c.post('/api/style/sync')).status).toBe(501)
    } finally {
      await prod.close()
    }
  })
})
