import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { createTestApp, type TestApp } from '../helpers/app.js'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
  // Throwaway routes to exercise the error handler. Registered before the app is ready.
  const typed = t.app.withTypeProvider<ZodTypeProvider>()
  typed.post(
    '/_test/validate',
    { schema: { body: z.object({ email: z.email('Enter a valid email.'), n: z.number().int() }) } },
    async () => ({ ok: true }),
  )
  t.app.get('/_test/boom', async () => {
    throw new Error('secret: password=hunter2')
  })
  await t.app.ready()
})
afterAll(() => t.close())

describe('health', () => {
  it('GET /health is liveness and needs no dependencies', async () => {
    const res = await t.app.inject('/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /ready checks postgres, redis and storage', async () => {
    const res = await t.app.inject('/ready')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', storage: 'ok' },
    })
  })

  it('GET /ready reports the dependency that is down', async () => {
    const broken = await createTestApp({ S3_BUCKET: 'bucket-that-does-not-exist' })
    try {
      const res = await broken.app.inject('/ready')
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({
        status: 'not_ready',
        checks: { postgres: 'ok', redis: 'ok', storage: 'down' },
      })
    } finally {
      await broken.close()
    }
  })

  it('GET /ready fails while draining so the load balancer moves on', async () => {
    const draining = await createTestApp()
    try {
      draining.app.draining = true
      const res = await draining.app.inject('/ready')
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ status: 'draining' })
      expect((await draining.app.inject('/health')).statusCode).toBe(200)
    } finally {
      await draining.close()
    }
  })
})

describe('error format', () => {
  it('unknown routes are { error: { code, message } }', async () => {
    const res = await t.app.inject('/api/nope')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/nope.' },
    })
  })

  it('validation errors name the field and list every issue', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/_test/validate',
      payload: { email: 'nope', n: 1.5 },
    })
    expect(res.statusCode).toBe(422)
    const { error } = res.json()
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toBe('Enter a valid email.')
    expect(error.details.field).toBe('email')
    expect(error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['email', 'n'])
  })

  it('malformed JSON is a clear 400, not a stack trace', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/_test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('unexpected errors are a generic 500 that never leaks the message', async () => {
    const res = await t.app.inject('/_test/boom')
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' },
    })
    expect(res.body).not.toContain('hunter2')
  })
})

describe('request ids', () => {
  it('generates one and returns it in the header', async () => {
    const res = await t.app.inject('/health')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps a well-formed id from the caller', async () => {
    const res = await t.app.inject({
      url: '/health',
      headers: { 'x-request-id': 'trace-abc-12345' },
    })
    expect(res.headers['x-request-id']).toBe('trace-abc-12345')
  })

  it('replaces a malformed id instead of trusting it', async () => {
    const res = await t.app.inject({
      url: '/health',
      headers: { 'x-request-id': 'bad id\twith spaces' },
    })
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('CORS', () => {
  const preflight = (origin: string) =>
    t.app.inject({
      method: 'OPTIONS',
      url: '/api/anything',
      headers: { origin, 'access-control-request-method': 'POST' },
    })

  it('allows the front end origin, with credentials', async () => {
    const res = await preflight('http://localhost:5173')
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('does not allow other origins', async () => {
    const res = await preflight('http://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('rate limiting', () => {
  it('returns 429 in the standard error format once the limit is hit; health is exempt', async () => {
    await t.deps.redis.flushdb()
    const limited = await createTestApp({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_SEC: '60' })
    try {
      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await limited.app.inject('/api/nope')).statusCode)
      expect(codes).toEqual([404, 404, 404, 429, 429])
      const res = await limited.app.inject('/api/nope')
      expect(res.json().error.code).toBe('RATE_LIMITED')
      expect(res.json().error.details.retryAfterSec).toBeGreaterThan(0)
      expect((await limited.app.inject('/health')).statusCode).toBe(200)
      expect((await limited.app.inject('/ready')).statusCode).toBe(200)
    } finally {
      await limited.close()
      await t.deps.redis.flushdb()
    }
  })
})
