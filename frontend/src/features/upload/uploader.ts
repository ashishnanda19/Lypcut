/**
 * Sends one video to the backend: create the project, open an upload, send the parts straight to storage with the
 * presigned links the API hands out, then ask the API to check the file and start processing.
 *
 * Storage is the source of truth for which parts arrived (the API asks it), so pausing, a dropped connection or a
 * closed tab never costs more than the parts that were in flight. Nothing here touches the DOM, so it is tested with a
 * fake transport.
 */
import { api as defaultApi, ApiError } from '@/api/client'
import type { Job, Project } from '@/types'

/** Where a video is going: a new project (the default), or a Reel that teaches the assistant the person's style. */
export interface UploadOptions {
  purpose?: 'style_reel'
}

export interface UploadEvents {
  /** 0-100, and a rough number of seconds left once there is enough data to guess. */
  progress(percent: number, secondsLeft: number | null): void
  /** Every byte is sent; the server is checking the file and starting processing. */
  finishing(): void
  /** The project's id, or for a style Reel the Reel's. */
  done(id: string): void
  failed(message: string, retryable: boolean): void
}

export interface UploadHandle {
  start(): void
  pause(): void
  resume(): void
  retry(): void
  /** Stops and removes the half-made project. Best effort; never throws. */
  cancel(): void
}

interface UploadDto {
  id: string
  projectId: string | null
  status: string
  sizeBytes: number
  partSize: number
  totalParts: number
  parts: Array<{ partNumber: number; size: number }>
}

type Api = Pick<typeof defaultApi, 'get' | 'post' | 'delete'>

export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
) => Promise<void>

export class PartError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Part upload failed (${status})`)
    this.name = 'PartError'
    this.status = status
  }
}

/** PUTs a slice of the file with progress. XMLHttpRequest, because fetch cannot report upload progress. */
export const xhrPut: PutPart = (url, body, onProgress, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PartError(xhr.status))
    xhr.onerror = () => reject(new PartError(0))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })

export interface UploaderDeps {
  api: Api
  put: PutPart
  /** Waits; replaced in tests so retries are instant. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Parts sent at once. */
  concurrency: number
  now: () => number
}

const defaults: UploaderDeps = {
  api: defaultApi,
  put: xhrPut,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    }),
  concurrency: 3,
  now: () => Date.now(),
}

const PART_ATTEMPTS = 4
/** How many links to ask for at a time. Links last an hour, so asking a few ahead is cheap. */
const PRESIGN_BATCH = 8
const COMPLETE_ROUNDS = 3

/** Errors that mean this file will never be accepted, as opposed to "try again". */
const FINAL_CODES = new Set([
  'LIMIT_VIDEO_LENGTH',
  'LIMIT_MONTHLY_UPLOADS',
  'LIMIT_STYLE_REELS',
  'LIMIT_REEL_LENGTH',
  'UNSUPPORTED_MEDIA',
  'PAYLOAD_TOO_LARGE',
  'CHECKSUM_MISMATCH',
  'VALIDATION_ERROR',
  'FORBIDDEN',
])

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export class Uploader implements UploadHandle {
  private readonly deps: UploaderDeps
  private readonly file: File
  private readonly durationSec: number | undefined
  private readonly events: UploadEvents
  private readonly options: UploadOptions
  private projectId: string | null = null
  private upload: UploadDto | null = null
  private sent = new Map<number, number>()
  private links = new Map<number, string>()
  private inFlight = new Map<number, number>()
  private abort = new AbortController()
  private generation = 0
  private paused = false
  private cancelled = false
  private finished = false
  private startedAt = 0
  private bytesAtStart = 0

  constructor(
    file: File,
    durationSec: number | undefined,
    events: UploadEvents,
    deps: Partial<UploaderDeps> = {},
    /** Continue an earlier, unfinished upload into this project instead of making a new one. */
    projectId: string | null = null,
    options: UploadOptions = {},
  ) {
    this.options = options
    this.projectId = projectId
    this.file = file
    this.durationSec = durationSec
    this.events = events
    this.deps = { ...defaults, ...deps }
  }

  start() {
    void this.drive()
  }

  pause() {
    if (this.paused || this.finished) return
    this.paused = true
    this.abort.abort()
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    void this.drive()
  }

  retry() {
    if (this.cancelled || this.finished) return
    this.paused = false
    void this.drive()
  }

  cancel() {
    if (this.cancelled) return
    this.cancelled = true
    this.abort.abort()
    const { upload, projectId } = this
    if (this.finished) return
    void (async () => {
      try {
        if (upload) await this.deps.api.delete(`/uploads/${upload.id}`)
      } catch {
        /* the sweep will abort it when it expires */
      }
      try {
        if (projectId) await this.deps.api.delete(`/projects/${projectId}`)
      } catch {
        /* the person can delete it from the dashboard */
      }
    })()
  }

  /** One run of the transfer. A newer run (after pause/resume/retry) makes an older one stand down. */
  private async drive() {
    const mine = ++this.generation
    this.abort = new AbortController()
    const { signal } = this.abort
    const stale = () => mine !== this.generation || this.cancelled
    try {
      await this.ensureUpload()
      if (stale()) return
      await this.sendMissingParts(signal, stale)
      if (stale() || this.paused) return
      await this.complete(signal, stale)
    } catch (e) {
      if (stale() || isAbort(e)) return
      await this.fail(e)
    }
  }

  private async ensureUpload() {
    if (this.upload) {
      // Coming back: ask storage what it holds, not what we remember.
      const { upload } = await this.deps.api.get<{ upload: UploadDto }>(
        `/uploads/${this.upload.id}`,
      )
      this.adopt(upload)
      return
    }
    if (!this.projectId && !this.options.purpose) {
      const { project } = await this.deps.api.post<{ project: Project }>('/projects', {
        fileName: this.file.name,
        ...(this.durationSec ? { durationSec: this.durationSec } : {}),
      })
      this.projectId = project.id
    }
    const { upload } = await this.deps.api.post<{ upload: UploadDto }>('/uploads', {
      // A style Reel has no project: it says what it is for instead.
      ...(this.options.purpose ? { purpose: this.options.purpose } : { projectId: this.projectId }),
      fileName: this.file.name,
      contentType: this.file.type || undefined,
      sizeBytes: this.file.size,
      ...(this.durationSec ? { durationSec: this.durationSec } : {}),
    })
    this.adopt(upload)
  }

  private adopt(upload: UploadDto) {
    this.upload = upload
    this.sent = new Map(upload.parts.map((p) => [p.partNumber, p.size]))
    this.links.clear()
    this.startedAt = this.deps.now()
    this.bytesAtStart = this.confirmedBytes()
    this.report()
  }

  private confirmedBytes() {
    let n = 0
    for (const size of this.sent.values()) n += size
    return n
  }

  private report() {
    let bytes = this.confirmedBytes()
    for (const loaded of this.inFlight.values()) bytes += loaded
    const total = this.file.size
    // Never show 100% before the server has accepted the file.
    const percent = Math.min(99, Math.floor((bytes / total) * 100))
    const elapsed = (this.deps.now() - this.startedAt) / 1000
    const rate = elapsed > 1.5 ? (bytes - this.bytesAtStart) / elapsed : 0
    this.events.progress(percent, rate > 0 ? Math.max(1, Math.round((total - bytes) / rate)) : null)
  }

  private async sendMissingParts(signal: AbortSignal, stale: () => boolean) {
    const upload = this.upload!
    const missing: number[] = []
    for (let n = 1; n <= upload.totalParts; n++) if (!this.sent.has(n)) missing.push(n)
    let next = 0
    const worker = async () => {
      while (!stale() && !signal.aborted) {
        const n = missing[next++]
        if (n === undefined) return
        await this.sendPart(n, missing, signal, stale)
      }
    }
    const lanes = Math.min(this.deps.concurrency, missing.length)
    await Promise.all(Array.from({ length: lanes }, worker))
  }

  private slice(n: number) {
    const { partSize } = this.upload!
    return this.file.slice((n - 1) * partSize, Math.min(n * partSize, this.file.size))
  }

  private async linkFor(n: number, missing: number[]): Promise<string> {
    const have = this.links.get(n)
    if (have) return have
    // Ask for this part and the next few that still need a link.
    const from = missing.indexOf(n)
    const batch = missing.slice(from, from + PRESIGN_BATCH).filter((p) => !this.links.has(p))
    const res = await this.deps.api.post<{ urls: Array<{ partNumber: number; url: string }> }>(
      `/uploads/${this.upload!.id}/parts`,
      { partNumbers: batch },
    )
    for (const u of res.urls) this.links.set(u.partNumber, u.url)
    const link = this.links.get(n)
    if (!link) throw new ApiError('The server did not give an upload link.', 502)
    return link
  }

  private async sendPart(n: number, missing: number[], signal: AbortSignal, stale: () => boolean) {
    const body = this.slice(n)
    for (let attempt = 1; ; attempt++) {
      if (stale() || signal.aborted) return
      try {
        const link = await this.linkFor(n, missing)
        this.inFlight.set(n, 0)
        await this.deps.put(
          link,
          body,
          (loaded) => {
            this.inFlight.set(n, loaded)
            this.report()
          },
          signal,
        )
        this.inFlight.delete(n)
        this.sent.set(n, body.size)
        this.report()
        return
      } catch (e) {
        this.inFlight.delete(n)
        if (isAbort(e)) throw e
        // An expired or refused link: ask for a new one next time.
        if (e instanceof PartError && (e.status === 403 || e.status === 400)) this.links.delete(n)
        const final = e instanceof ApiError && FINAL_CODES.has(e.code ?? '')
        if (final || attempt >= PART_ATTEMPTS) throw e
        await this.deps.sleep(400 * 2 ** (attempt - 1), signal)
      }
    }
  }

  private async complete(signal: AbortSignal, stale: () => boolean) {
    this.events.finishing()
    for (let round = 1; ; round++) {
      try {
        const res = await this.deps.api.post<{
          project?: Project
          job?: Job
          reel?: { id: string }
        }>(`/uploads/${this.upload!.id}/complete`)
        this.finished = true
        this.events.progress(100, 0)
        this.events.done((res.project?.id ?? res.reel?.id)!)
        return
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        // Storage disagrees about some parts: send those again.
        if (e.code === 'UPLOAD_INCOMPLETE' && round < COMPLETE_ROUNDS) {
          const bad = [
            ...((e.details?.missing as number[] | undefined) ?? []),
            ...((e.details?.wrongSize as number[] | undefined) ?? []),
          ]
          for (const n of bad) {
            this.sent.delete(n)
            this.links.delete(n)
          }
          await this.sendMissingParts(signal, stale)
          if (stale() || this.paused) return
          this.events.finishing()
          continue
        }
        throw e
      }
    }
  }

  private async fail(e: unknown) {
    const expired = e instanceof ApiError && e.code === 'UPLOAD_EXPIRED'
    if (expired) {
      // The 24 hour window passed. The next try opens a fresh upload for the same project.
      this.upload = null
      this.events.failed('This upload timed out. Press Retry to start it again.', true)
      return
    }
    if (e instanceof ApiError && e.code && FINAL_CODES.has(e.code)) {
      this.events.failed(e.message, false)
      this.discard()
      return
    }
    if (e instanceof ApiError) {
      this.events.failed(e.message, true)
      return
    }
    this.events.failed(
      e instanceof PartError && e.status === 0
        ? 'Your connection dropped. Press Retry to continue where it stopped.'
        : 'The upload was interrupted. Press Retry to continue where it stopped.',
      true,
    )
  }

  /** This file will never be accepted: remove the empty project it would leave behind. */
  private discard() {
    const { projectId } = this
    this.projectId = null
    this.upload = null
    if (projectId) void this.deps.api.delete(`/projects/${projectId}`).catch(() => undefined)
  }
}
