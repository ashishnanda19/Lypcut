import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { projects, uploads } from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { makeVideo } from '../helpers/media.js'
import { fullUpload, startUpload } from '../helpers/upload.js'
import { ORIGIN, signup, type Person } from '../helpers/world.js'

/**
 * User A must not be able to read or change anything of user B's. Every route that takes an id of
 * something a user owns is listed here, so a new route cannot quietly skip the check: it is added
 * to this table as each step lands (jobs, transcript, timeline, assets...).
 */

let t: TestApp
let a: Person
let b: Person
let theirs: { projectId: string; uploadId: string; jobId: string }
let video: string

beforeAll(async () => {
  t = await createTestApp()
  video = await makeVideo({ seconds: 5 })
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
  a = await signup(t)
  b = await signup(t)
  const started = await startUpload(b.c, video)
  // B also has a finished upload, so they have a processing job.
  const finished = await fullUpload(b.c, video)
  theirs = {
    projectId: started.projectId,
    uploadId: started.upload.id,
    jobId: finished.done.body.job.id,
  }
})

interface Route {
  name: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: (ids: typeof theirs) => string
  body?: object
}

const ROUTES: Route[] = [
  { name: 'read a project', method: 'GET', url: (i) => `/api/projects/${i.projectId}` },
  {
    name: 'rename a project',
    method: 'PATCH',
    url: (i) => `/api/projects/${i.projectId}`,
    body: { title: 'Hijacked' },
  },
  { name: 'delete a project', method: 'DELETE', url: (i) => `/api/projects/${i.projectId}` },
  { name: 'read a job', method: 'GET', url: (i) => `/api/jobs/${i.jobId}` },
  { name: 'retry a job', method: 'POST', url: (i) => `/api/jobs/${i.jobId}/retry` },
  { name: 'read an upload', method: 'GET', url: (i) => `/api/uploads/${i.uploadId}` },
  {
    name: 'get part URLs for an upload',
    method: 'POST',
    url: (i) => `/api/uploads/${i.uploadId}/parts`,
    body: { partNumbers: [1] },
  },
  { name: 'complete an upload', method: 'POST', url: (i) => `/api/uploads/${i.uploadId}/complete` },
  { name: 'abort an upload', method: 'DELETE', url: (i) => `/api/uploads/${i.uploadId}` },
  {
    name: 'start an upload in their project',
    method: 'POST',
    url: () => '/api/uploads',
    body: { fileName: 'x.mp4', sizeBytes: 1000 },
  },
]

const call = (c: TestClient, r: Route, ids: typeof theirs) => {
  const body =
    r.name === 'start an upload in their project' ? { ...r.body, projectId: ids.projectId } : r.body
  return c.request(r.method, r.url(ids), body ?? (r.method === 'GET' ? undefined : {}))
}

describe('another user’s things', () => {
  for (const route of ROUTES) {
    it(`cannot ${route.name}, and cannot tell it exists`, async () => {
      const real = await call(a.c, route, theirs)
      const imaginary = await call(a.c, route, {
        projectId: uuidv7(),
        uploadId: uuidv7(),
        jobId: uuidv7(),
      })
      expect(real.status).toBe(404)
      // The answer is the same as for something that does not exist, so ids cannot be probed.
      expect(real.body).toEqual(imaginary.body)
    })
  }

  it('leaves everything of B’s exactly as it was after all those attempts', async () => {
    for (const route of ROUTES) await call(a.c, route, theirs)
    const [project] = await t.deps.database.db
      .select()
      .from(projects)
      .where(eq(projects.id, theirs.projectId))
    expect(project).toBeTruthy()
    expect(project!.title).not.toBe('Hijacked')
    const [upload] = await t.deps.database.db
      .select()
      .from(uploads)
      .where(eq(uploads.id, theirs.uploadId))
    expect(upload!.status).toBe('initiated')
    // B still sees and can use them.
    expect((await b.c.get(`/api/projects/${theirs.projectId}`)).status).toBe(200)
    expect((await b.c.get(`/api/uploads/${theirs.uploadId}`)).status).toBe(200)
  })

  it('never appear in A’s project list', async () => {
    expect((await a.c.get('/api/projects')).body).toEqual([])
    // B has two: one with an upload started, one finished.
    expect((await b.c.get('/api/projects')).body).toHaveLength(2)
  })

  it('cannot be reached with a presigned URL meant for B', async () => {
    // B gets a URL for their own part. A has no way to get one for B's upload.
    const own = await b.c.post(`/api/uploads/${theirs.uploadId}/parts`, { partNumbers: [1] })
    expect(own.status).toBe(200)
    const stolen = await a.c.post(`/api/uploads/${theirs.uploadId}/parts`, { partNumbers: [1] })
    expect(stolen.status).toBe(404)
    expect(JSON.stringify(stolen.body)).not.toContain('X-Amz')
  })
})

describe('nobody logged in', () => {
  for (const route of ROUTES) {
    it(`cannot ${route.name}`, async () => {
      const res = await call(new TestClient(t.app, { headers: { origin: ORIGIN } }), route, theirs)
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHENTICATED')
    })
  }

  it('cannot list projects', async () => {
    const res = await new TestClient(t.app).get('/api/projects')
    expect(res.status).toBe(401)
  })
})
