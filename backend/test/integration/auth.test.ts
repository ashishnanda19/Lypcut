import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessions, userPreferences, users } from '../../src/db/schema/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { TEST_ENV } from '../helpers/env.js'

const ORIGIN = 'http://localhost:5173'
const PASSWORD = 'correct-horse-battery'
let n = 0
const newEmail = () => `asha${++n}@example.com`

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
})

const browser = (app = t.app) => new TestClient(app, { headers: { origin: ORIGIN } })
const db = () => t.deps.database.db

async function signedUp(email = newEmail(), name = 'Asha Rao') {
  const c = browser()
  const res = await c.post('/api/auth/signup', { name, email, password: PASSWORD })
  expect(res.status).toBe(201)
  return { c, email, res }
}

describe('signup', () => {
  it('creates the account and logs the browser in with httpOnly cookies, not body tokens', async () => {
    const { c, email, res } = await signedUp()
    expect(res.body.user).toMatchObject({
      name: 'Asha Rao',
      email,
      language: 'hinglish',
      contentType: null,
      onboarded: false,
      plan: 'free',
    })
    expect(res.body.tokens).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(c.cookie('lypcut_rt')!)

    const access = res.setCookies.find((x) => x.startsWith('lypcut_at='))!
    const refresh = res.setCookies.find((x) => x.startsWith('lypcut_rt='))!
    for (const cookie of [access, refresh]) {
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/SameSite=Lax/i)
    }
    expect(access).toMatch(/Path=\/;/)
    expect(refresh).toMatch(/Path=\/api\/auth/)
    expect(access).toMatch(/Max-Age=900/)
  })

  it('stores an argon2id hash, never the password, and a hashed refresh token', async () => {
    const { c, email } = await signedUp()
    const [user] = await db().select().from(users).where(eq(users.email, email))
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/)
    expect(user!.passwordHash).not.toContain(PASSWORD)

    const [session] = await db().select().from(sessions).where(eq(sessions.userId, user!.id))
    const refresh = c.cookie('lypcut_rt')!
    expect(session!.tokenHash).toBe(createHash('sha256').update(refresh).digest('hex'))
    expect(session!.tokenHash).not.toContain(refresh)
    const prefs = await db()
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user!.id))
    expect(prefs).toHaveLength(1)
  })

  it('lower-cases and trims the email, so duplicates are caught however they are typed', async () => {
    await signedUp('asha.dup@example.com')
    const res = await browser().post('/api/auth/signup', {
      email: '  ASHA.Dup@Example.COM ',
      password: PASSWORD,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'EMAIL_TAKEN', details: { field: 'email' } })
  })

  it('derives a name from the email when none is given', async () => {
    const res = await browser().post('/api/auth/signup', {
      email: 'priya.sharma@example.com',
      password: PASSWORD,
    })
    expect(res.body.user.name).toBe('Priya Sharma')
  })

  it('explains what is wrong, naming the field', async () => {
    const bad = await browser().post('/api/auth/signup', {
      email: 'not-an-email',
      password: PASSWORD,
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Enter a valid email, like aarav@gmail.com.',
      details: { field: 'email' },
    })
    const short = await browser().post('/api/auth/signup', { email: newEmail(), password: 'short' })
    expect(short.body.error.details.field).toBe('password')
    expect(short.body.error.message).toMatch(/at least 8/)
    const huge = await browser().post('/api/auth/signup', {
      email: newEmail(),
      password: 'x'.repeat(129),
    })
    expect(huge.status).toBe(422)
  })
})

describe('login', () => {
  it('logs in with the right password and records the time', async () => {
    const { email } = await signedUp()
    const c = browser()
    const res = await c.post('/api/auth/login', { email: email.toUpperCase(), password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(email)
    expect(c.cookie('lypcut_at')).toBeTruthy()
    const [user] = await db().select().from(users).where(eq(users.email, email))
    expect(user!.lastLoginAt).toBeInstanceOf(Date)
  })

  it('gives the same answer for a wrong password and an unknown email, so emails cannot be probed', async () => {
    const { email } = await signedUp()
    const wrong = await browser().post('/api/auth/login', { email, password: 'wrong-password-1' })
    const unknown = await browser().post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'wrong-password-1',
    })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('locks an account after repeated failures, even for the right password, then recovers on success elsewhere', async () => {
    const lockApp = await createTestApp({ LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_SEC: '60' })
    try {
      const { email } = await signedUp()
      const c = browser(lockApp.app)
      for (let i = 0; i < 3; i++) {
        expect(
          (await c.post('/api/auth/login', { email, password: 'wrong-password-1' })).status,
        ).toBe(401)
      }
      const locked = await c.post('/api/auth/login', { email, password: PASSWORD })
      expect(locked.status).toBe(429)
      expect(locked.body.error.code).toBe('RATE_LIMITED')
      expect(locked.body.error.details.retryAfterSec).toBeGreaterThan(0)

      // Other accounts are unaffected.
      const other = await signedUp()
      expect(
        (
          await browser(lockApp.app).post('/api/auth/login', {
            email: other.email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200)
    } finally {
      await lockApp.close()
    }
  })

  it('a successful login clears the failure count', async () => {
    const lockApp = await createTestApp({ LOGIN_MAX_FAILURES: '3' })
    try {
      const { email } = await signedUp()
      const c = browser(lockApp.app)
      for (let round = 0; round < 3; round++) {
        await c.post('/api/auth/login', { email, password: 'wrong-password-1' })
        await c.post('/api/auth/login', { email, password: 'wrong-password-1' })
        expect((await c.post('/api/auth/login', { email, password: PASSWORD })).status).toBe(200)
      }
    } finally {
      await lockApp.close()
    }
  })

  it('rate limits the auth endpoints per IP far below the global limit', async () => {
    const limited = await createTestApp({ AUTH_RATE_LIMIT_MAX: '3' })
    try {
      const { email } = await signedUp()
      const c = browser(limited.app)
      const codes: number[] = []
      for (let i = 0; i < 5; i++)
        codes.push((await c.post('/api/auth/login', { email, password: PASSWORD })).status)
      expect(codes).toEqual([200, 200, 200, 429, 429])
      expect((await limited.app.inject('/health')).statusCode).toBe(200)
    } finally {
      await limited.close()
    }
  })
})

describe('current user', () => {
  it('needs a login', async () => {
    const res = await browser().get('/api/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('returns the user for a logged-in browser', async () => {
    const { c, email } = await signedUp()
    const res = await c.get('/api/me')
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(email)
  })

  it('accepts a Bearer token for non-browser clients', async () => {
    const { email } = await signedUp()
    const api = browser()
    const login = await api.post(
      '/api/auth/login',
      { email, password: PASSWORD },
      { 'x-auth-mode': 'bearer' },
    )
    expect(login.body.tokens.accessToken).toBeTruthy()
    expect(login.setCookies).toEqual([])

    const bare = new TestClient(t.app)
    const me = await bare.get('/api/me', {
      authorization: `Bearer ${login.body.tokens.accessToken}`,
    })
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
  })

  it('rejects forged, foreign-signed, expired and alg=none tokens', async () => {
    const { c } = await signedUp()
    const good = c.cookie('lypcut_at')!
    const bare = new TestClient(t.app)
    const asBearer = (token: string) => bare.get('/api/me', { authorization: `Bearer ${token}` })

    const [h, p, s] = good.split('.')
    expect((await asBearer(`${h}.${p}.${s!.slice(0, -2)}xx`)).status).toBe(401)

    const key = new TextEncoder().encode('not-the-real-secret-not-the-real-secret')
    const foreign = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuer('lypcut')
      .setAudience('lypcut-api')
      .setExpirationTime('5m')
      .sign(key)
    expect((await asBearer(foreign)).status).toBe(401)

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`
    expect((await asBearer(none)).status).toBe(401)

    const secret = new TextEncoder().encode(TEST_ENV.AUTH_ACCESS_SECRET)
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('x')
      .setIssuer('lypcut')
      .setAudience('lypcut-api')
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(secret)
    expect((await asBearer(expired)).status).toBe(401)
  })

  it('stops working when the access token expires', async () => {
    const shortApp = await createTestApp({ ACCESS_TOKEN_TTL_SEC: '1' })
    try {
      const { email } = await signedUp()
      const c = browser(shortApp.app)
      await c.post('/api/auth/login', { email, password: PASSWORD })
      expect((await c.get('/api/me')).status).toBe(200)
      await new Promise((r) => setTimeout(r, 2100))
      expect((await c.get('/api/me')).status).toBe(401)
    } finally {
      await shortApp.close()
    }
  })

  it('updates the name and preferences, and finishes onboarding once', async () => {
    const { c } = await signedUp()
    const res = await c.patch('/api/me', {
      name: ' Asha R ',
      language: 'hi',
      contentType: 'clipper',
      onboarded: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({
      name: 'Asha R',
      language: 'hi',
      contentType: 'clipper',
      onboarded: true,
    })
    // It persists.
    expect((await c.get('/api/me')).body.user).toMatchObject({ language: 'hi', onboarded: true })
    // Onboarding cannot be switched back off, and an unknown language is refused.
    expect((await c.patch('/api/me', { onboarded: false })).status).toBe(422)
    expect((await c.patch('/api/me', { language: 'klingon' })).status).toBe(422)
    expect((await c.patch('/api/me', { contentType: null })).body.user.contentType).toBeNull()
  })

  it('does not let a user change their own plan', async () => {
    const { c } = await signedUp()
    const res = await c.patch('/api/me', { plan: 'studio', name: 'Still Free' })
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ plan: 'free', name: 'Still Free' })
  })
})

describe('refresh tokens', () => {
  it('rotate: each refresh works once and issues a new pair', async () => {
    const { c } = await signedUp()
    const before = c.cookie('lypcut_rt')!
    const res = await c.post('/api/auth/refresh')
    expect(res.status).toBe(200)
    expect(c.cookie('lypcut_rt')).not.toBe(before)
    expect((await c.get('/api/me')).status).toBe(200)
  })

  it('reuse of a retired token revokes the whole login, new token included', async () => {
    const strict = await createTestApp({ REFRESH_REUSE_GRACE_SEC: '0' })
    try {
      const { email } = await signedUp()
      const c = browser(strict.app)
      await c.post('/api/auth/login', { email, password: PASSWORD })
      const stolen = c.cookie('lypcut_rt')!
      expect((await c.post('/api/auth/refresh')).status).toBe(200)
      const legit = c.cookie('lypcut_rt')!
      await new Promise((r) => setTimeout(r, 25))

      // An attacker replays the retired token.
      const attacker = new TestClient(strict.app, { headers: { origin: ORIGIN } })
      const replay = await attacker.post('/api/auth/refresh', { refreshToken: stolen })
      expect(replay.status).toBe(401)

      // The legitimate holder's newer token is dead too: the family is revoked.
      const after = await new TestClient(strict.app, { headers: { origin: ORIGIN } }).post(
        '/api/auth/refresh',
        { refreshToken: legit },
      )
      expect(after.status).toBe(401)
    } finally {
      await strict.close()
    }
  })

  it('a retired token reused within the grace window is treated as a race: refused, but the login survives', async () => {
    const { c } = await signedUp()
    const first = c.cookie('lypcut_rt')!
    expect((await c.post('/api/auth/refresh')).status).toBe(200)
    const racing = new TestClient(t.app, { headers: { origin: ORIGIN } })
    expect((await racing.post('/api/auth/refresh', { refreshToken: first })).status).toBe(401)
    // The browser's newer token still works.
    expect((await c.post('/api/auth/refresh')).status).toBe(200)
  })

  it('refuse an expired, unknown or missing token and clear the cookies', async () => {
    const { c } = await signedUp()
    await db()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
    const expired = await c.post('/api/auth/refresh')
    expect(expired.status).toBe(401)
    expect(expired.setCookies.some((x) => x.startsWith('lypcut_rt=;'))).toBe(true)
    expect(
      (await browser().post('/api/auth/refresh', { refreshToken: 'unknown-token-value' })).status,
    ).toBe(401)
    expect((await browser().post('/api/auth/refresh')).status).toBe(401)
  })

  it('work in bearer mode through the request body', async () => {
    const { email } = await signedUp()
    const api = new TestClient(t.app)
    const login = await api.post(
      '/api/auth/login',
      { email, password: PASSWORD },
      { 'x-auth-mode': 'bearer' },
    )
    const refreshed = await api.post(
      '/api/auth/refresh',
      { refreshToken: login.body.tokens.refreshToken },
      { 'x-auth-mode': 'bearer' },
    )
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.tokens.refreshToken).not.toBe(login.body.tokens.refreshToken)
  })
})

describe('requests without a body', () => {
  it('accept a JSON Content-Type header with no body, as many HTTP clients send', async () => {
    const { c } = await signedUp()
    const res = await c.request('DELETE', '/api/me', undefined, {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(200)
  })

  it('still reject a missing body where one is required, with a field-level error', async () => {
    const res = await browser().request('POST', '/api/auth/login', undefined, {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('logout', () => {
  it('ends the login: cookies cleared and the refresh token stops working', async () => {
    const { c } = await signedUp()
    const refresh = c.cookie('lypcut_rt')!
    const res = await c.post('/api/auth/logout')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(c.cookie('lypcut_at')).toBeUndefined()
    expect(c.cookie('lypcut_rt')).toBeUndefined()
    const attacker = new TestClient(t.app, { headers: { origin: ORIGIN } })
    expect((await attacker.post('/api/auth/refresh', { refreshToken: refresh })).status).toBe(401)
  })

  it('succeeds even when not logged in', async () => {
    expect((await browser().post('/api/auth/logout')).status).toBe(200)
  })

  it('only ends this login: another device stays signed in', async () => {
    const { c: phone, email } = await signedUp()
    const laptop = browser()
    await laptop.post('/api/auth/login', { email, password: PASSWORD })
    await phone.post('/api/auth/logout')
    expect((await laptop.get('/api/me')).status).toBe(200)
    expect((await laptop.post('/api/auth/refresh')).status).toBe(200)
  })
})

describe('cross-site request protection', () => {
  it('refuses writes from an unknown origin, even with valid cookies', async () => {
    const { c } = await signedUp()
    const res = await c.patch('/api/me', { name: 'Hacked' }, { origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect((await c.get('/api/me')).body.user.name).toBe('Asha Rao')
  })

  it('refuses a cross-site write that carries no Origin', async () => {
    const { c } = await signedUp()
    const res = await new TestClient(t.app).request('DELETE', '/api/me', undefined, {
      cookie: `lypcut_at=${c.cookie('lypcut_at')}`,
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(403)
  })

  it('allows the front end origin, and non-browser callers with no Origin', async () => {
    const { c } = await signedUp()
    expect((await c.patch('/api/me', { name: 'Fine' }, { origin: ORIGIN })).status).toBe(200)
    const bare = new TestClient(t.app)
    const login = await bare.post(
      '/api/auth/login',
      { email: (await c.get('/api/me')).body.user.email, password: PASSWORD },
      { 'x-auth-mode': 'bearer' },
    )
    expect(login.status).toBe(200)
  })

  it('does not restrict reads', async () => {
    const { c } = await signedUp()
    expect((await c.get('/api/me', { origin: 'http://evil.example' })).status).toBe(200)
  })
})

describe('social login', () => {
  it('Google sign-in says clearly that it is not available yet', async () => {
    const res = await browser().post('/api/auth/google')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED')
  })
})
