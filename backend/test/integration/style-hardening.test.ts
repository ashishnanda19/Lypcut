import { eq } from 'drizzle-orm'
import { Worker } from 'bullmq'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jobs } from '../../src/db/schema/index.js'
import { listDeadLetters, retryDeadLetter } from '../../src/queue/dead-letters.js'
import { bullConnectionOptions, createRedis } from '../../src/queue/connection.js'
import { QUEUES, styleJobOptions } from '../../src/queue/queues.js'
import { DEVELOPMENT_APP_SECRET } from '../../src/modules/privacy/routes.js'
import { signRequest } from '../../src/style/instagram/deletion.js'
import { onStyleJobFailed } from '../../src/workers/style.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { signup } from '../helpers/world.js'

let t: TestApp
const log = pino({ level: 'silent' })
beforeAll(async () => {
  t = await createTestApp({ STYLE_RATE_LIMIT_PER_MIN: '3' })
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
})
const db = () => t.deps.database.db

describe('limits on Style actions', () => {
  it('counts each person on their own, answers in the standard format, and leaves reading alone', async () => {
    const a = await signup(t)
    const b = await signup(t)
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await a.c.post('/api/style/connect')).status)
    expect(codes).toEqual([200, 200, 200, 429, 429])
    const refused = await a.c.post('/api/style/connect')
    expect(refused.body.error.code).toBe('RATE_LIMITED')
    expect(refused.body.error.details.retryAfterSec).toBeGreaterThan(0)
    // Same address, different person: not affected.
    expect((await b.c.post('/api/style/connect')).status).toBe(200)
    // Reading the page is not limited by this.
    for (let i = 0; i < 8; i++) expect((await a.c.get('/api/style')).status).toBe(200)
    // Each action has its own count.
    expect((await a.c.del('/api/style/connect')).status).toBe(200)
  })

  it('limits the public deletion callback by address, whatever is in it', async () => {
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/privacy/instagram/deletion',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          signed_request: signRequest({ user_id: '1' }, 'not-the-secret'),
        }).toString(),
      })
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await send()).statusCode)
    expect(codes).toEqual([403, 403, 403, 429, 429])
    // A genuine one from the same address is held back too, until the minute is up.
    const real = await t.app.inject({
      method: 'POST',
      url: '/api/privacy/instagram/deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        signed_request: signRequest({ user_id: '1' }, DEVELOPMENT_APP_SECRET),
      }).toString(),
    })
    expect(real.statusCode).toBe(429)
  })
})

describe('retries and giving up', () => {
  it('waits longer between tries on the style queue than on the others', async () => {
    const queue = t.deps.queues.style.opts?.defaultJobOptions
    expect(queue).toMatchObject({
      attempts: t.deps.config.JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: t.deps.config.STYLE_JOB_BACKOFF_MS },
      removeOnFail: false,
    })
    expect(t.deps.config.STYLE_JOB_BACKOFF_MS).toBeGreaterThan(t.deps.config.JOB_BACKOFF_MS)
    expect(styleJobOptions({ JOB_ATTEMPTS: 4, STYLE_JOB_BACKOFF_MS: 1000 })).toMatchObject({
      attempts: 4,
      backoff: { delay: 1000 },
    })
  })

  const stuck = async (type: 'style_sync' | 'style_analysis' | 'style_refresh') => {
    const p = await signup(t)
    const [row] = await db()
      .insert(jobs)
      .values({ userId: p.id, type, status: 'running' })
      .returning()
    return row!
  }

  it('leaves a job alone while tries remain, and says what failed once none do', async () => {
    const ctx = { deps: t.deps, log }
    const row = await stuck('style_sync')
    const bull = (attemptsMade: number) => ({
      data: { jobId: row.id },
      name: 'style_sync',
      attemptsMade,
      opts: { attempts: 5 },
    })
    await onStyleJobFailed(ctx, bull(2), new Error('instagram said no'))
    expect((await db().select().from(jobs).where(eq(jobs.id, row.id)))[0]).toMatchObject({
      status: 'running',
    })
    await onStyleJobFailed(ctx, bull(5), new Error('instagram said no'))
    const after = (await db().select().from(jobs).where(eq(jobs.id, row.id)))[0]!
    expect(after).toMatchObject({
      status: 'failed',
      errorCode: 'SYNC_FAILED',
      error: 'Instagram could not be read just now.',
    })
    // What the person can see is a sentence, never the error that was thrown.
    expect(JSON.stringify(after)).not.toMatch(/instagram said no/)
  })

  it('gives each kind of job its own sentence', async () => {
    const ctx = { deps: t.deps, log }
    for (const [type, code] of [
      ['style_analysis', 'ANALYSIS_FAILED'],
      ['style_refresh', 'REFRESH_FAILED'],
    ] as const) {
      const row = await stuck(type)
      await onStyleJobFailed(
        ctx,
        { data: { jobId: row.id }, name: type, attemptsMade: 1, opts: { attempts: 1 } },
        new Error('x'),
      )
      expect((await db().select().from(jobs).where(eq(jobs.id, row.id)))[0]!.errorCode).toBe(code)
    }
  })
})

describe('dead letters', () => {
  it('lists a job that used up its tries, and gives it a fresh set once asked', async () => {
    const p = await signup(t)
    const [row] = await db()
      .insert(jobs)
      .values({ userId: p.id, type: 'style_sync', status: 'failed', errorCode: 'SYNC_FAILED' })
      .returning()
    await t.deps.queues.style.add('style_sync', { jobId: row!.id }, { jobId: row!.id, attempts: 1 })
    // A worker that always fails, so the job really does end up in the queue's failed set.
    const failing = new Worker(
      QUEUES.style,
      async () => {
        throw new Error('storage is away')
      },
      { connection: createRedis(t.deps.config, bullConnectionOptions) },
    )
    try {
      await new Promise<void>((resolve) => failing.once('failed', () => resolve()))
    } finally {
      await failing.close()
    }

    const list = await listDeadLetters(t.deps.queues, t.deps.database)
    expect(list).toEqual([
      expect.objectContaining({
        queue: 'style',
        jobId: row!.id,
        type: 'style_sync',
        userId: p.id,
        reason: 'storage is away',
      }),
    ])

    expect(await retryDeadLetter(t.deps.queues, t.deps.database, row!.id)).toBe(true)
    expect((await db().select().from(jobs).where(eq(jobs.id, row!.id)))[0]).toMatchObject({
      status: 'queued',
      errorCode: null,
    })
    expect(await listDeadLetters(t.deps.queues, t.deps.database)).toEqual([])
    // Nothing to retry for an id that never failed.
    expect(await retryDeadLetter(t.deps.queues, t.deps.database, row!.id)).toBe(false)
    expect(await retryDeadLetter(t.deps.queues, t.deps.database, 'nope')).toBe(false)
  })
})
