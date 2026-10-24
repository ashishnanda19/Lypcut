import { delay, http, HttpResponse, ws } from 'msw'
import type { Job, User } from '@/types'
import { searchTranscript } from '@/lib/search'
import {
  addSamples,
  clearProjects,
  db,
  findProject,
  getSource,
  publicProject,
  REELS,
  saveProjects,
  styleProfile,
  type DbProject,
} from './db'
import { createExportJob, createProcessingJob, ensureJob, retryJob, subscribeJob } from './jobs'

/** Every route here becomes a real endpoint later. Keep the shapes in src/types. */

const lag = (min = 160, max = 380) => delay(min + Math.random() * (max - min))
const notFound = (what: string) =>
  HttpResponse.json({ message: `${what} not found` }, { status: 404 })

function nameFromEmail(email: string) {
  const local = email.split('@')[0] ?? 'creator'
  const word = local.replace(/[._-]+/g, ' ').trim()
  return word.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Creator'
}

function userFor(email: string, name?: string): User {
  return {
    id: `u_${email.toLowerCase()}`,
    name: name?.trim() || nameFromEmail(email),
    email,
    language: 'hinglish',
    contentType: null,
    onboarded: false,
    plan: 'free',
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const jobsSocket = ws.link('wss://api.lypcut.mock/jobs')

const jobsHandler = jobsSocket.addEventListener('connection', ({ client }) => {
  const unsubs = new Map<string, () => void>()
  client.addEventListener('message', (event) => {
    let msg: { type?: string; jobId?: string }
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (msg.type !== 'subscribe' || !msg.jobId) return
    const job = ensureJob(msg.jobId) ?? db.jobs.get(msg.jobId)
    if (!job) {
      client.send(JSON.stringify({ type: 'error', jobId: msg.jobId, message: 'Unknown job' }))
      return
    }
    unsubs.get(msg.jobId)?.()
    unsubs.set(
      msg.jobId,
      subscribeJob(msg.jobId, (j) => client.send(JSON.stringify({ type: 'job', job: j }))),
    )
  })
  client.addEventListener('close', () => unsubs.forEach((u) => u()))
})

export const handlers = [
  jobsHandler,
  /* ------------------------------ auth ------------------------------ */
  http.post('/api/auth/login', async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string }
    await lag()
    if (!body.email || !EMAIL.test(body.email)) {
      return HttpResponse.json(
        { message: 'Enter a valid email, like aarav@gmail.com.', field: 'email' },
        { status: 422 },
      )
    }
    if (!body.password || body.password.length < 6) {
      return HttpResponse.json(
        { message: 'That password is too short. Use at least 6 characters.', field: 'password' },
        { status: 401 },
      )
    }
    if (db.projects.length === 0) addSamples()
    return HttpResponse.json({ user: { ...userFor(body.email), onboarded: true } })
  }),
  http.post('/api/auth/signup', async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string; name?: string }
    await lag()
    if (!body.email || !EMAIL.test(body.email)) {
      return HttpResponse.json(
        { message: 'Enter a valid email, like aarav@gmail.com.', field: 'email' },
        { status: 422 },
      )
    }
    if (!body.password || body.password.length < 6) {
      return HttpResponse.json(
        { message: 'Choose a password with at least 6 characters.', field: 'password' },
        { status: 422 },
      )
    }
    clearProjects()
    return HttpResponse.json({ user: userFor(body.email, body.name) })
  }),
  http.post('/api/auth/google', async () => {
    await lag(300, 600)
    addSamples()
    return HttpResponse.json({
      user: { ...userFor('aarav.sharma@gmail.com', 'Aarav Sharma'), onboarded: false },
    })
  }),
  http.delete('/api/me', async () => {
    await lag(400, 800)
    clearProjects()
    db.style.connected = false
    db.style.source = null
    return HttpResponse.json({ ok: true })
  }),

  /* ----------------------------- projects ---------------------------- */
  http.get('/api/projects', async () => {
    await lag()
    const list = [...db.projects]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(publicProject)
    return HttpResponse.json(list)
  }),
  http.post('/api/projects/samples', async () => {
    await lag()
    addSamples()
    return HttpResponse.json(db.projects.map(publicProject))
  }),
  http.get('/api/projects/:id', async ({ params }) => {
    await lag(120, 260)
    const p = findProject(String(params.id))
    return p ? HttpResponse.json(publicProject(p)) : notFound('Project')
  }),
  http.post('/api/projects', async ({ request }) => {
    const body = (await request.json()) as {
      title?: string
      fileName?: string
      durationSec?: number
    }
    await lag()
    const duration = Math.max(
      45,
      Math.min(3 * 3600, Math.round(body.durationSec ?? 240 + Math.random() * 420)),
    )
    const id = `p_${Date.now().toString(36)}`
    const title = (body.title ?? body.fileName ?? 'Untitled project').replace(
      /\.[a-z0-9]{2,4}$/i,
      '',
    )
    const now = new Date().toISOString()
    const project: DbProject = {
      id,
      title,
      status: 'processing',
      durationSec: duration,
      language: 'hinglish',
      thumbSeed: id,
      createdAt: now,
      updatedAt: now,
      progress: 0,
      assets: [
        {
          id: `${id}_raw`,
          kind: 'raw',
          label: body.fileName ?? 'Original upload',
          durationSec: duration,
        },
      ],
      seed: {
        offset: Math.floor(Math.random() * 20),
        count: Math.max(12, Math.ceil(duration / 4.8)),
      },
    }
    db.projects.unshift(project)
    const job = createProcessingJob(id, body.fileName ?? title)
    saveProjects()
    // The real duration comes from the generated transcript so everything lines up.
    const src = getSource(id)
    if (src) {
      project.durationSec = src.duration
      project.assets = [
        {
          id: `${id}_raw`,
          kind: 'raw',
          label: body.fileName ?? 'Original upload',
          durationSec: src.duration,
        },
        {
          id: `${id}_proxy`,
          kind: 'proxy',
          label: 'Editing proxy (360p)',
          durationSec: src.duration,
          url: '/demo/proxy.mp4',
        },
      ]
      saveProjects()
    }
    return HttpResponse.json({ project: publicProject(project), job }, { status: 201 })
  }),
  http.patch('/api/projects/:id', async ({ params, request }) => {
    const p = findProject(String(params.id))
    if (!p) return notFound('Project')
    const body = (await request.json()) as { title?: string }
    if (body.title) p.title = body.title
    p.updatedAt = new Date().toISOString()
    saveProjects()
    await lag(80, 160)
    return HttpResponse.json(publicProject(p))
  }),
  http.delete('/api/projects/:id', async ({ params }) => {
    await lag(120, 240)
    db.projects = db.projects.filter((p) => p.id !== params.id)
    saveProjects()
    return HttpResponse.json({ ok: true })
  }),

  /* ------------------------- project content ------------------------- */
  http.get('/api/projects/:id/transcript', async ({ params }) => {
    await lag(200, 420)
    const src = getSource(String(params.id))
    return src ? HttpResponse.json(src.transcript) : notFound('Transcript')
  }),
  http.get('/api/projects/:id/scenes', async ({ params }) => {
    await lag(100, 240)
    const src = getSource(String(params.id))
    return src ? HttpResponse.json(src.scenes) : notFound('Scenes')
  }),
  http.get('/api/projects/:id/highlights', async ({ params }) => {
    await lag(250, 500)
    const src = getSource(String(params.id))
    return src ? HttpResponse.json(src.highlights) : notFound('Highlights')
  }),
  http.get('/api/projects/:id/chapters', async ({ params }) => {
    await lag(150, 300)
    const src = getSource(String(params.id))
    return src ? HttpResponse.json(src.chapters) : notFound('Chapters')
  }),
  http.get('/api/projects/:id/search', async ({ params, request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? ''
    await lag(90, 220)
    const src = getSource(String(params.id))
    if (!src) return notFound('Project')
    return HttpResponse.json(searchTranscript(src.transcript, q))
  }),

  /* ------------------------------- jobs ------------------------------ */
  http.get('/api/jobs/:id', async ({ params }) => {
    await lag(60, 140)
    const job: Job | undefined = ensureJob(String(params.id)) ?? db.jobs.get(String(params.id))
    return job ? HttpResponse.json(job) : notFound('Job')
  }),
  http.post('/api/jobs/:id/retry', async ({ params }) => {
    await lag(120, 260)
    const job = retryJob(String(params.id))
    return job ? HttpResponse.json(job) : notFound('Job')
  }),
  http.post('/api/projects/:id/export', async ({ params, request }) => {
    const body = (await request.json()) as { kind?: 'export' | 'otio'; durationMs?: number }
    await lag(150, 300)
    if (!findProject(String(params.id))) return notFound('Project')
    const job = createExportJob(String(params.id), body.kind ?? 'export', body.durationMs ?? 6500)
    return HttpResponse.json(job, { status: 201 })
  }),

  /* --------------------------- style profile -------------------------- */
  http.get('/api/style', async () => {
    await lag()
    return HttpResponse.json(styleProfile())
  }),
  http.get('/api/style/reels', async () => {
    await lag(200, 400)
    return HttpResponse.json(
      db.style.connected && db.style.source === 'instagram'
        ? REELS
        : db.style.connected
          ? REELS.slice(0, db.style.reels)
          : [],
    )
  }),
  http.post('/api/style/connect', async () => {
    await lag(700, 1200)
    db.style.connected = true
    db.style.source = 'instagram'
    return HttpResponse.json(styleProfile())
  }),
  http.post('/api/style/upload', async ({ request }) => {
    const body = (await request.json()) as { count?: number }
    await lag(800, 1400)
    db.style.connected = true
    db.style.source = 'upload'
    db.style.reels = Math.max(3, Math.min(REELS.length, body.count ?? 3))
    return HttpResponse.json(styleProfile())
  }),
  http.delete('/api/style/connect', async () => {
    await lag(200, 400)
    db.style.connected = false
    db.style.source = null
    return HttpResponse.json(styleProfile())
  }),
]
