import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jobs, projects } from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'
import { TranscriptionError } from '../../src/transcription/types.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { makeSceneVideo } from '../helpers/media.js'
import { jobRow, startProcessing, tmpRoot, waitForJob } from '../helpers/pipeline.js'
import { delay, ScriptedProvider, speaks } from '../helpers/provider.js'
import { fullUpload } from '../helpers/upload.js'
import { Feed, cookieHeader, listen } from '../helpers/ws.js'
import { ORIGIN, signup, type Person } from '../helpers/world.js'

let t: TestApp
let url: string
let tmp: string
let sample: string
const toClose: Array<{ close(): Promise<unknown> }> = []

beforeAll(async () => {
  tmp = tmpRoot()
  sample = await makeSceneVideo({
    segments: [
      { color: 'red', seconds: 4 },
      { color: 'blue', seconds: 5 },
    ],
  })
  t = await createTestApp({
    JOB_ATTEMPTS: '2',
    JOB_BACKOFF_MS: '50',
    JOBS_WS_REFRESH_MS: '250',
    TMP_DIR: tmp,
  })
  url = await listen(t)
})
afterAll(async () => {
  await t.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})
afterEach(async () => {
  while (toClose.length) await toClose.pop()!.close()
})

const db = () => t.deps.database.db

/** A transcription that takes a while and reports progress, so there is something to watch. */
const slowProvider = (ms = 600) =>
  new ScriptedProvider(async (_n, opts) => {
    for (let i = 1; i <= 4; i++) {
      await delay(ms / 4)
      opts.onProgress?.(i / 4)
    }
    return speaks()
  })

async function newJob(): Promise<Person & { projectId: string; jobId: string }> {
  const person = await signup(t)
  const { projectId, done } = await fullUpload(person.c, sample)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return { ...person, projectId, jobId: done.body.job.id as string }
}

const run = (provider: ScriptedProvider) => {
  const w = startProcessing(t.deps, provider)
  toClose.push(w)
  return w
}

describe('GET /api/jobs/:id', () => {
  it('returns the front end’s Job shape, and nothing internal', async () => {
    const { c, projectId, jobId } = await newJob()
    const res = await c.get(`/api/jobs/${jobId}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: jobId,
      projectId,
      kind: 'processing',
      status: 'queued',
      progress: 0,
      step: 0,
      detail: 'Uploaded',
    })
  })

  it('shows the findings and a finished state after processing', async () => {
    const { c, jobId } = await newJob()
    run(new ScriptedProvider(() => speaks()))
    await waitForJob(t.deps, jobId, 'done')
    const res = await c.get(`/api/jobs/${jobId}`)
    expect(res.body).toMatchObject({
      status: 'done',
      progress: 100,
      step: 4,
      detail: 'Ready to edit',
      found: { language: 'Hinglish (Hindi + English)', speakers: 1 },
    })
    expect(res.body.found.scenes).toBeGreaterThanOrEqual(1)
    for (const internal of ['userId', 'payload', 'result', 'attempts', 'stage', 'errorCode']) {
      expect(res.body, internal).not.toHaveProperty(internal)
    }
  })

  it('answers a stranger exactly as it answers for a job that does not exist', async () => {
    const mine = await newJob()
    const stranger = await signup(t)
    const real = await stranger.c.get(`/api/jobs/${mine.jobId}`)
    const imaginary = await stranger.c.get(`/api/jobs/${uuidv7()}`)
    expect(real.status).toBe(404)
    expect(real.body).toEqual(imaginary.body)
    expect((await stranger.c.get('/api/jobs/not-a-uuid')).status).toBe(404)
  })

  it('needs a login', async () => {
    const { jobId } = await newJob()
    expect((await new TestClient(t.app).get(`/api/jobs/${jobId}`)).status).toBe(401)
  })

  it('does not expose internal housekeeping jobs', async () => {
    const { c, id } = await newJob()
    const [cleanup] = await db()
      .insert(jobs)
      .values({ userId: id, type: 'delete_project', payload: { prefix: 'users/x/' } })
      .returning()
    expect((await c.get(`/api/jobs/${cleanup!.id}`)).status).toBe(404)
  })
})

describe('POST /api/jobs/:id/retry', () => {
  it('puts a failed job back and it finishes, keeping its id', async () => {
    const { c, projectId, jobId } = await newJob()
    let healthy = false
    const provider = new ScriptedProvider(() => {
      if (!healthy) throw new TranscriptionError('refused', false)
      return speaks()
    })
    run(provider)
    await waitForJob(t.deps, jobId, 'failed')
    expect((await c.get(`/api/jobs/${jobId}`)).body).toMatchObject({
      status: 'failed',
      step: 2,
      detail: 'Transcribing stopped',
      error: "We couldn't transcribe this audio.",
    })

    healthy = true
    const retried = await c.post(`/api/jobs/${jobId}/retry`)
    expect(retried.status).toBe(200)
    expect(retried.body).toMatchObject({ id: jobId, status: 'queued' })
    expect(retried.body.error).toBeUndefined()
    expect((await c.get(`/api/projects/${projectId}`)).body.status).toBe('processing')

    await waitForJob(t.deps, jobId, 'done')
    expect((await c.get(`/api/projects/${projectId}`)).body.status).toBe('ready')
  })

  it('is safe to press twice: a job already queued or running just reports where it is', async () => {
    const { c, jobId } = await newJob()
    const first = await c.post(`/api/jobs/${jobId}/retry`)
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('queued')
    expect((await c.post(`/api/jobs/${jobId}/retry`)).body.id).toBe(jobId)
  })

  it('refuses to retry a job that already finished', async () => {
    const { c, jobId } = await newJob()
    run(new ScriptedProvider(() => speaks()))
    await waitForJob(t.deps, jobId, 'done')
    const res = await c.post(`/api/jobs/${jobId}/retry`)
    expect(res.status).toBe(409)
  })

  it('cannot retry someone else’s job, or one that is not a processing job', async () => {
    const mine = await newJob()
    const stranger = await signup(t)
    expect((await stranger.c.post(`/api/jobs/${mine.jobId}/retry`)).status).toBe(404)
    const [other] = await db()
      .insert(jobs)
      .values({ userId: mine.id, projectId: mine.projectId, type: 'otio', status: 'failed' })
      .returning()
    expect((await mine.c.post(`/api/jobs/${other!.id}/retry`)).status).toBe(404)
  })
})

describe('the live feed (WebSocket)', () => {
  const open = async (c: TestClient) => {
    const f = await Feed.open(url, c)
    toClose.push(f)
    return f
  }

  it('is refused before the connection is made without a login or from another site', async () => {
    const { c } = await newJob()
    const nobody = await Feed.connect(url, { origin: ORIGIN })
    expect(nobody).toEqual({ refused: 401 })
    const wrongSite = await Feed.connect(url, {
      cookie: cookieHeader(c),
      origin: 'http://evil.example',
    })
    expect(wrongSite).toEqual({ refused: 403 })
    // No Origin at all (a script, not a browser) is allowed, with a Bearer token or cookie.
    const script = await Feed.connect(url, { cookie: cookieHeader(c) })
    expect('refused' in script).toBe(false)
    if (!('refused' in script)) await script.close()
  })

  it('tells a subscriber where the job stands at once, then streams it to the end', async () => {
    const { c, jobId } = await newJob()
    const feed = await open(c)
    feed.subscribe(jobId)
    const first = await feed.waitFor((m) => m.type === 'job')
    expect(first.job).toMatchObject({ id: jobId, status: 'queued', progress: 0, step: 0 })

    run(slowProvider())
    await feed.waitFor((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')

    const jobsSeen = feed.jobs
    const progress = jobsSeen.map((j) => j.progress as number)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    const steps = new Set(jobsSeen.map((j) => j.step))
    for (const s of [1, 2, 3, 4]) expect(steps.has(s), `step ${s}`).toBe(true)
    // The last message is exactly what polling returns.
    expect(jobsSeen[jobsSeen.length - 1]).toEqual((await c.get(`/api/jobs/${jobId}`)).body)
    // And nothing internal leaks through it.
    expect(JSON.stringify(jobsSeen)).not.toMatch(/userId|payload|attempts/)
  })

  it('never sends the same state twice in a row', async () => {
    const { c, jobId } = await newJob()
    const feed = await open(c)
    feed.subscribe(jobId)
    run(slowProvider())
    await feed.waitFor((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')
    const states = feed.messages.map((m) => JSON.stringify(m))
    for (let i = 1; i < states.length; i++) expect(states[i]).not.toBe(states[i - 1])
  })

  it('a failure arrives in the same shape the mock’s failure does', async () => {
    const { c, jobId } = await newJob()
    const feed = await open(c)
    feed.subscribe(jobId)
    run(
      new ScriptedProvider(() => {
        throw new TranscriptionError('refused', false)
      }),
    )
    const last = await feed.waitFor(
      (m) => m.type === 'job' && (m.job as { status: string }).status === 'failed',
    )
    expect(last.job).toMatchObject({
      id: jobId,
      kind: 'processing',
      status: 'failed',
      step: 2,
      detail: 'Transcribing stopped',
      error: "We couldn't transcribe this audio.",
    })
    expect((last.job as { found: object }).found).toMatchObject({ scenes: expect.any(Number) })
    expect(last.job).toEqual((await c.get(`/api/jobs/${jobId}`)).body)
  })

  it('answers an unknown job and someone else’s job the same way, with the mock’s error', async () => {
    const mine = await newJob()
    const stranger = await signup(t)
    const feed = await open(stranger.c)
    feed.subscribe(mine.jobId)
    feed.subscribe(uuidv7())
    feed.subscribe('not-a-uuid')
    await delay(400)
    const errors = feed.messages.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(3)
    for (const e of errors) expect(e.message).toBe('Unknown job')
    // (Replies can arrive in any order: a malformed id is refused without a database read.)
    expect(errors.find((e) => e.jobId === mine.jobId)).toEqual({
      type: 'error',
      jobId: mine.jobId,
      message: 'Unknown job',
    })
    expect(feed.messages.some((m) => m.type === 'job')).toBe(false)
    // And the stranger receives nothing about the job later either.
    run(slowProvider(300))
    await waitForJob(t.deps, mine.jobId, 'done')
    expect(feed.messages.every((m) => m.type === 'error')).toBe(true)
  })

  it('a client that reconnects loses nothing: it subscribes again and is told the current state', async () => {
    const { c, jobId } = await newJob()
    const first = await open(c)
    first.subscribe(jobId)
    run(slowProvider(1200))
    await first.waitFor((m) => m.type === 'job' && (m.job as { step: number }).step >= 2)
    const before = first.jobs[first.jobs.length - 1]!.progress as number
    await first.close() // the connection drops while the job carries on

    const second = await open(c)
    second.subscribe(jobId)
    const snapshot = await second.waitFor((m) => m.type === 'job')
    expect((snapshot.job as { progress: number }).progress).toBeGreaterThanOrEqual(before)
    await second.waitFor((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')
    expect(second.jobs[second.jobs.length - 1]).toEqual((await c.get(`/api/jobs/${jobId}`)).body)
  })

  it('a job that finished while the client was away is reported done on reconnect', async () => {
    const { c, jobId } = await newJob()
    run(new ScriptedProvider(() => speaks()))
    await waitForJob(t.deps, jobId, 'done')
    const feed = await open(c)
    feed.subscribe(jobId)
    const snapshot = await feed.waitFor((m) => m.type === 'job')
    expect(snapshot.job).toMatchObject({ status: 'done', progress: 100, step: 4 })
  })

  it('two connections watching one job both hear it, and an unsubscribed one stops hearing', async () => {
    const { c, jobId } = await newJob()
    const a = await open(c)
    const b = await open(c)
    a.subscribe(jobId)
    b.subscribe(jobId)
    await a.waitFor((m) => m.type === 'job')
    await b.waitFor((m) => m.type === 'job')
    b.send({ type: 'unsubscribe', jobId })
    await delay(150)
    const heardBefore = b.messages.length

    run(slowProvider(500))
    await a.waitFor((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')
    expect(b.messages.length).toBe(heardBefore)
  })

  it('ignores nonsense without dropping the connection, and answers a ping', async () => {
    const { c, jobId } = await newJob()
    const feed = await open(c)
    feed.send('this is not json')
    feed.send(JSON.stringify({ type: 'subscribe' })) // missing jobId
    feed.send(JSON.stringify({ type: 'launch-missiles' }))
    feed.send(JSON.stringify([1, 2, 3]))
    feed.socket.send(Buffer.from([1, 2, 3]), { binary: true })
    feed.send({ type: 'ping' })
    await feed.waitFor((m) => m.type === 'pong')
    expect(feed.messages.filter((m) => m.type !== 'pong')).toEqual([])
    // Still works afterwards.
    feed.subscribe(jobId)
    await feed.waitFor((m) => m.type === 'job')
  })

  it('drops a connection that sends an oversized message (1009, message too big)', async () => {
    const { c } = await newJob()
    const feed = await open(c)
    feed.send('x'.repeat(10_000))
    await feed.waitFor(() => feed.closed !== null, 3000).catch(() => undefined)
    await delay(200)
    expect(feed.closed).toEqual({ code: 1009 })
  })

  it('limits how many jobs one connection may watch', async () => {
    const { c, id, projectId } = await newJob()
    const ids: string[] = []
    for (let i = 0; i < 22; i++) {
      const [row] = await db()
        .insert(jobs)
        .values({ userId: id, projectId, type: 'processing' })
        .returning({ id: jobs.id })
      ids.push(row!.id)
    }
    const feed = await open(c)
    for (const jobId of ids) feed.subscribe(jobId)
    await delay(800)
    expect(feed.messages.filter((m) => m.type === 'job')).toHaveLength(20)
    expect(feed.messages.filter((m) => m.type === 'error')).toHaveLength(2)
  })

  it('catches a change whose announcement was lost, by re-reading watched jobs', async () => {
    const { c, jobId } = await newJob()
    const feed = await open(c)
    feed.subscribe(jobId)
    await feed.waitFor((m) => m.type === 'job')
    // Change the row without announcing it on Redis, as if the message had been dropped.
    await db()
      .update(jobs)
      .set({ progress: 42, step: 2, detail: 'Transcribing', status: 'running' })
      .where(eq(jobs.id, jobId))
    const update = await feed.waitFor(
      (m) => m.type === 'job' && (m.job as { progress: number }).progress === 42,
      5000,
    )
    expect(update.job).toMatchObject({ status: 'running', step: 2, detail: 'Transcribing' })
  })

  it('stops telling a client about a job once the project is deleted', async () => {
    const { c, projectId, jobId } = await newJob()
    const feed = await open(c)
    feed.subscribe(jobId)
    await feed.waitFor((m) => m.type === 'job')
    await c.del(`/api/projects/${projectId}`)
    expect(await db().select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0)
    // The job is gone with it; a new subscription gets the same answer as for any unknown job.
    const again = await open(c)
    again.subscribe(jobId)
    expect(await again.waitFor((m) => m.type === 'error')).toMatchObject({ message: 'Unknown job' })
  })

  it('is closed cleanly when the server shuts down', async () => {
    const own = await createTestApp()
    const ownUrl = await listen(own)
    const person = await signup(own)
    const feed = await Feed.open(ownUrl, person.c)
    await own.close()
    await delay(300)
    expect(feed.closed).toEqual({ code: 1001 })
  })
})

describe('a finished job stays consistent between feed and polling', () => {
  it('has identical content in both', async () => {
    const { c, jobId } = await newJob()
    const feed = await Feed.open(url, c)
    toClose.push(feed)
    feed.subscribe(jobId)
    run(new ScriptedProvider(() => speaks()))
    await feed.waitFor((m) => m.type === 'job' && (m.job as { status: string }).status === 'done')
    const polled = (await c.get(`/api/jobs/${jobId}`)).body
    expect(feed.jobs[feed.jobs.length - 1]).toEqual(polled)
    expect((await jobRow(t.deps, jobId)).status).toBe('done')
  })
})
