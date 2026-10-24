import type { Job } from '@/types'
import { db, findProject, getSource, saveProjects } from './db'

/**
 * Simulated background jobs (processing a new upload, rendering an export).
 * A job advances on timers; anyone subscribed (the WebSocket mock, or a polling GET)
 * sees the same state. Replace with real queue events later.
 */

export const PROCESSING_STEPS = [
  'Uploaded',
  'Splitting into clips',
  'Transcribing',
  'Indexing scenes and speakers',
  'Ready',
] as const

type Listener = (job: Job) => void
const listeners = new Map<string, Set<Listener>>()
const timers = new Map<string, ReturnType<typeof setInterval>>()
const retried = new Set<string>()

export function subscribeJob(id: string, fn: Listener): () => void {
  let set = listeners.get(id)
  if (!set) listeners.set(id, (set = new Set()))
  set.add(fn)
  const job = db.jobs.get(id)
  if (job) fn(job)
  return () => set!.delete(fn)
}

function publish(job: Job) {
  db.jobs.set(job.id, job)
  listeners.get(job.id)?.forEach((fn) => fn(job))
}

/** Step durations in ms for the processing job. Total about 10 seconds. */
const STEP_MS = [700, 2400, 3200, 2400]

function startProcessing(job: Job) {
  const failing = job.id.includes('fail') && !retried.has(job.id)
  const src = job.projectId ? getSource(job.projectId) : undefined
  const startedAt = Date.now()
  const total = STEP_MS.reduce((a, b) => a + b, 0)

  const tick = () => {
    const elapsed = Date.now() - startedAt
    let acc = 0
    let step = 0
    for (let i = 0; i < STEP_MS.length; i++) {
      if (elapsed >= acc + STEP_MS[i]!) {
        acc += STEP_MS[i]!
        step = i + 1
      } else break
    }
    const inStep = step < STEP_MS.length ? (elapsed - acc) / STEP_MS[step]! : 1
    const progress = Math.min(100, Math.round((Math.min(elapsed, total) / total) * 100))

    const found: Job['found'] = {}
    if (step >= 2) found.scenes = src?.scenes.length ?? 12
    if (step >= 3) {
      found.language = 'Hinglish (Hindi + English)'
      found.speakers = src?.transcript.speakers.length ?? 2
    }
    if (step >= 4) found.hooks = src?.highlights.length ?? 6

    if (failing && step === 2 && inStep > 0.45) {
      stop(job.id)
      publish({
        ...job,
        status: 'failed',
        step: 2,
        progress: 41,
        found,
        error: "We couldn't read a clear audio track from this file.",
        detail: 'Transcribing stopped',
      })
      return
    }

    if (step >= STEP_MS.length) {
      stop(job.id)
      const p = job.projectId ? findProject(job.projectId) : undefined
      if (p) {
        p.status = 'ready'
        p.progress = undefined
        p.hooksFound = src?.highlights.length
        p.updatedAt = new Date().toISOString()
        saveProjects()
      }
      publish({ ...job, status: 'done', step: 4, progress: 100, found, detail: 'Ready to edit' })
      return
    }
    publish({ ...job, status: 'running', step, progress, found, detail: PROCESSING_STEPS[step] })
  }

  stop(job.id)
  timers.set(job.id, setInterval(tick, 250))
  tick()
}

const EXPORT_PHASES: Array<[number, string]> = [
  [14, 'Preparing your timeline'],
  [48, 'Rendering frames'],
  [68, 'Burning in captions'],
  [92, 'Encoding video'],
  [100, 'Packaging your file'],
]

function startExport(job: Job, durationMs: number) {
  const startedAt = Date.now()
  const tick = () => {
    const progress = Math.min(100, Math.round(((Date.now() - startedAt) / durationMs) * 100))
    if (progress >= 100) {
      stop(job.id)
      const p = job.projectId ? findProject(job.projectId) : undefined
      if (p) {
        p.status = 'exported'
        p.updatedAt = new Date().toISOString()
        saveProjects()
      }
      publish({
        ...job,
        status: 'done',
        progress: 100,
        detail: 'Your file is ready',
        resultUrl: `mock://render/${job.id}`,
      })
      return
    }
    const phase = EXPORT_PHASES.find(([upto]) => progress < upto)?.[1] ?? 'Packaging your file'
    publish({ ...job, status: 'running', progress, detail: phase })
  }
  stop(job.id)
  timers.set(job.id, setInterval(tick, 200))
  tick()
}

function stop(id: string) {
  const t = timers.get(id)
  if (t) clearInterval(t)
  timers.delete(id)
}

/** Make sure a job exists and is running. Safe to call many times. */
export function ensureJob(id: string): Job | undefined {
  const existing = db.jobs.get(id)
  if (existing) {
    if (existing.status === 'queued') kick(existing)
    return existing
  }
  // A known project with this job id (for example after a page refresh): start processing again.
  const project = db.projects.find((p) => p.jobId === id)
  if (!project) return undefined
  const job: Job = {
    id,
    projectId: project.id,
    kind: 'processing',
    status: 'queued',
    progress: 0,
    step: 0,
  }
  db.jobs.set(id, job)
  kick(job)
  return job
}

function kick(job: Job) {
  if (job.kind === 'processing') startProcessing(job)
}

export function createProcessingJob(projectId: string, fileName: string): Job {
  const id = `job_${projectId}${/fail/i.test(fileName) ? '_fail' : ''}`
  const job: Job = { id, projectId, kind: 'processing', status: 'queued', progress: 0, step: 0 }
  db.jobs.set(id, job)
  const p = findProject(projectId)
  if (p) p.jobId = id
  startProcessing(job)
  return job
}

export function retryJob(id: string): Job | undefined {
  const old = db.jobs.get(id) ?? ensureJob(id)
  if (!old) return undefined
  retried.add(id)
  const job: Job = {
    id,
    projectId: old.projectId,
    kind: old.kind,
    status: 'queued',
    progress: 0,
    step: 0,
  }
  db.jobs.set(id, job)
  const p = old.projectId ? findProject(old.projectId) : undefined
  if (p) {
    p.status = 'processing'
    p.progress = 0
  }
  if (job.kind === 'processing') startProcessing(job)
  return job
}

export function createExportJob(
  projectId: string,
  kind: 'export' | 'otio',
  durationMs: number,
): Job {
  const id = `exp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const job: Job = { id, projectId, kind, status: 'queued', progress: 0 }
  db.jobs.set(id, job)
  startExport(job, durationMs)
  return job
}
