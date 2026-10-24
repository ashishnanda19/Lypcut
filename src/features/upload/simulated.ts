import { api } from '@/api/client'
import type { Job, Project } from '@/types'
import type { UploadEvents, UploadHandle } from './uploader'

const TICK = 120

/**
 * The stand-in used with the mock API: a timer plays the part of the network, then the project is created.
 * Longer files take longer, within a sane range, so the screen behaves like a real upload.
 */
export class SimulatedUpload implements UploadHandle {
  private readonly totalMs: number
  private startedAt = 0
  private progress = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private cancelled = false
  private readonly file: File
  private readonly durationSec: number | undefined
  private readonly events: UploadEvents

  constructor(file: File, durationSec: number | undefined, events: UploadEvents) {
    this.file = file
    this.durationSec = durationSec
    this.events = events
    this.totalMs = Math.max(3200, Math.min(11000, (file.size / (18 * 1024 ** 2)) * 1000))
  }

  start() {
    this.startedAt = Date.now()
    this.run()
  }

  pause() {
    this.stop()
  }

  resume() {
    this.startedAt = Date.now() - (this.progress / 100) * this.totalMs
    this.run()
  }

  retry() {
    // A failure here happens after the transfer, so only the creating step is repeated.
    if (this.progress >= 100) void this.create()
    else {
      this.progress = 0
      this.start()
    }
  }

  cancel() {
    this.cancelled = true
    this.stop()
  }

  private run() {
    this.stop()
    this.timer = setInterval(() => {
      const p = Math.min(100, ((Date.now() - this.startedAt) / this.totalMs) * 100)
      if (p >= 100) {
        this.stop()
        this.progress = 100
        void this.create()
      } else {
        this.progress = Math.round(p)
        this.events.progress(this.progress, ((100 - this.progress) / 100) * (this.totalMs / 1000))
      }
    }, TICK)
  }

  private stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async create() {
    this.events.finishing()
    try {
      const res = await api.post<{ project: Project; job: Job }>('/projects', {
        fileName: this.file.name,
        durationSec: this.durationSec,
      })
      if (!this.cancelled) this.events.done(res.project.id)
    } catch (e) {
      if (!this.cancelled)
        this.events.failed(e instanceof Error ? e.message : 'Upload failed.', true)
    }
  }
}
