import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assets, jobs, projects, uploads, users } from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'
import { reconcileQueuedJobs, processMaintenanceJob } from '../../src/workers/maintenance.js'
import { pino } from 'pino'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { startMaintenanceWorker, waitFor } from '../helpers/worker.js'

const ORIGIN = 'http://localhost:5173'
const PASSWORD = 'correct-horse-battery'

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

async function signup(email: string) {
  const c = new TestClient(t.app, { headers: { origin: ORIGIN } })
  const res = await c.post('/api/auth/signup', { email, password: PASSWORD })
  return { c, id: res.body.user.id as string }
}

/** A project with a raw file stored, plus an upload that is still in flight (a real multipart upload with one part sent). */
async function seedStorage(userId: string) {
  const { db } = t.deps.database
  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, title: 'p', thumbSeed: 'x' })
    .returning()
  const base = `users/${userId}/projects/${project!.id}`
  await t.deps.storage.putObject(`${base}/proxy.mp4`, 'proxy-bytes')
  await t.deps.storage.putObject(`${base}/scenes/1.mp4`, 'scene-bytes')

  const key = `${base}/raw/${uuidv7()}.mp4`
  const uploadId = await t.deps.storage.createMultipart(key, 'video/mp4')
  const url = await t.deps.storage.presignPart(key, uploadId, 1, 300)
  const put = await fetch(url, { method: 'PUT', body: Buffer.alloc(5 * 1024 * 1024, 1) })
  expect(put.ok).toBe(true)
  const [asset] = await db
    .insert(assets)
    .values({ projectId: project!.id, kind: 'raw', storageKey: key, label: 'raw' })
    .returning()
  await db.insert(uploads).values({
    userId,
    projectId: project!.id,
    assetId: asset!.id,
    fileName: 'a.mp4',
    contentType: 'video/mp4',
    sizeBytes: 10 * 1024 * 1024,
    storageKey: key,
    s3UploadId: uploadId,
    partSize: 5 * 1024 * 1024,
    totalParts: 2,
    status: 'uploading',
    expiresAt: new Date(Date.now() + 3600_000),
  })
  return { key, uploadId, base }
}

describe('DELETE /api/me', () => {
  it('needs a login', async () => {
    const res = await new TestClient(t.app, { headers: { origin: ORIGIN } }).del('/api/me')
    expect(res.status).toBe(401)
  })

  it('removes the account from the database at once, then the worker removes the files', async () => {
    const a = await signup('delete.me@example.com')
    const b = await signup('keep.me@example.com')
    const aStore = await seedStorage(a.id)
    const bStore = await seedStorage(b.id)
    const accessBefore = a.c.cookie('lypcut_at')!

    const res = await a.c.del('/api/me')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(a.c.cookie('lypcut_at')).toBeUndefined()

    // Database: everything of A's is gone in the same transaction; B is untouched.
    const { db } = t.deps.database
    expect(await db.select().from(users).where(eq(users.id, a.id))).toHaveLength(0)
    expect(await db.select().from(projects).where(eq(projects.ownerId, a.id))).toHaveLength(0)
    expect(await db.select().from(uploads).where(eq(uploads.userId, a.id))).toHaveLength(0)
    expect(await db.select().from(projects).where(eq(projects.ownerId, b.id))).toHaveLength(1)

    // The promise to clean up files is already recorded, and no longer tied to the (deleted) user.
    const [job] = await db.select().from(jobs).where(eq(jobs.type, 'delete_account'))
    expect(job!.userId).toBeNull()
    expect(job!.payload).toMatchObject({ prefix: `users/${a.id}/` })

    // The old session is dead immediately, not when the access token runs out.
    const stale = await new TestClient(t.app).get('/api/me', {
      authorization: `Bearer ${accessBefore}`,
    })
    expect(stale.status).toBe(401)
    const relogin = await new TestClient(t.app, { headers: { origin: ORIGIN } }).post(
      '/api/auth/login',
      {
        email: 'delete.me@example.com',
        password: PASSWORD,
      },
    )
    expect(relogin.status).toBe(401)

    // Files: still there until the worker runs.
    expect(await t.deps.storage.head(`${aStore.base}/proxy.mp4`)).not.toBeNull()
    const worker = startMaintenanceWorker(t.deps)
    try {
      await waitFor(
        async () => {
          const [j] = await db.select().from(jobs).where(eq(jobs.id, job!.id))
          return j?.status === 'done' ? j : false
        },
        20_000,
        'cleanup job to finish',
      )
    } finally {
      await worker.close()
    }

    expect(await t.deps.storage.head(`${aStore.base}/proxy.mp4`)).toBeNull()
    expect(await t.deps.storage.head(`${aStore.base}/scenes/1.mp4`)).toBeNull()
    // The in-flight multipart upload was aborted, so its parts stop costing money.
    await expect(t.deps.storage.listParts(aStore.key, aStore.uploadId)).rejects.toThrow()
    // B's files and B's upload are untouched.
    expect(await t.deps.storage.head(`${bStore.base}/proxy.mp4`)).not.toBeNull()
    expect((await t.deps.storage.listParts(bStore.key, bStore.uploadId)).length).toBe(1)
  })

  it('a lost enqueue is recovered by the reconcile sweep', async () => {
    const a = await signup('lost.enqueue@example.com')
    await seedStorage(a.id)
    // Simulate the crash window: the job row exists, the queue never heard about it.
    const { db } = t.deps.database
    await t.deps.queues.maintenance.obliterate({ force: true }).catch(() => undefined)
    const res = await a.c.del('/api/me')
    expect(res.status).toBe(200)
    await t.deps.queues.maintenance.obliterate({ force: true })
    const [job] = await db.select().from(jobs).where(eq(jobs.type, 'delete_account'))
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(jobs.id, job!.id))

    const log = pino({ level: 'silent' })
    expect(await reconcileQueuedJobs({ deps: t.deps, log })).toBe(1)
    // Running the sweep again does not duplicate the work: the same BullMQ id is a no-op.
    await reconcileQueuedJobs({ deps: t.deps, log })
    expect(await t.deps.queues.maintenance.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(
      1,
    )

    const worker = startMaintenanceWorker(t.deps)
    try {
      await waitFor(
        async () =>
          (await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]?.status === 'done',
        20_000,
        'recovered job',
      )
    } finally {
      await worker.close()
    }
  })

  it('refuses a cleanup prefix that is not a user or project folder', async () => {
    const { db } = t.deps.database
    const log = pino({ level: 'silent' })
    for (const prefix of [
      '',
      'users/',
      'users/not-a-uuid/',
      '../',
      `users/${uuidv7()}/projects/`,
      '/',
    ]) {
      const [job] = await db
        .insert(jobs)
        .values({ type: 'delete_account', payload: { prefix } })
        .returning()
      await expect(
        processMaintenanceJob({ deps: t.deps, log }, {
          name: 'delete_account',
          data: { jobId: job!.id },
          attemptsMade: 0,
        } as never),
        `prefix ${JSON.stringify(prefix)}`,
      ).rejects.toThrow(/refusing/)
    }
  })
})
