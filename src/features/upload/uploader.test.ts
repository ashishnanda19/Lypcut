import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { PartError, Uploader, type PutPart, type UploadEvents } from './uploader'

const PART = 10

/** A tiny stand-in for the API and for storage, enough to exercise the uploader's decisions. */
function fakeServer(opts: { size: number; limit?: 'length'; expireOnComplete?: boolean }) {
  const stored = new Map<number, number>()
  const calls: string[] = []
  let uploads = 0
  let expireOnComplete = !!opts.expireOnComplete
  const totalParts = Math.ceil(opts.size / PART)
  const dto = () => ({
    id: `u${uploads}`,
    projectId: 'p1',
    status: 'uploading',
    sizeBytes: opts.size,
    partSize: PART,
    totalParts,
    parts: [...stored].map(([partNumber, size]) => ({ partNumber, size })),
  })
  const api = {
    get: vi.fn(async (path: string) => {
      calls.push(`GET ${path}`)
      return { upload: dto() }
    }),
    post: vi.fn(async (path: string, body?: unknown) => {
      calls.push(`POST ${path}`)
      if (path === '/projects') return { project: { id: 'p1' } }
      if (path === '/uploads') {
        if (opts.limit)
          throw new ApiError(
            'Free plan videos can be up to 10 minutes.',
            403,
            undefined,
            'LIMIT_VIDEO_LENGTH',
            {
              maxSeconds: 600,
            },
          )
        uploads++
        stored.clear()
        return { upload: dto() }
      }
      if (path.endsWith('/parts')) {
        const { partNumbers } = body as { partNumbers: number[] }
        return {
          urls: partNumbers.map((n) => ({ partNumber: n, url: `https://store/${uploads}/${n}` })),
        }
      }
      if (path.endsWith('/complete')) {
        if (expireOnComplete) {
          expireOnComplete = false
          throw new ApiError('This upload expired.', 410, undefined, 'UPLOAD_EXPIRED')
        }
        const missing = [...Array(totalParts).keys()]
          .map((i) => i + 1)
          .filter((n) => !stored.has(n))
        if (missing.length)
          throw new ApiError('Some parts are missing.', 422, undefined, 'UPLOAD_INCOMPLETE', {
            missing,
            wrongSize: [],
          })
        return { project: { id: 'p1' }, job: { id: 'j1' } }
      }
      throw new Error(`unexpected POST ${path}`)
    }),
    delete: vi.fn(async (path: string) => {
      calls.push(`DELETE ${path}`)
      return { ok: true }
    }),
  }
  return { api, stored, calls, dto }
}

function events() {
  const log: string[] = []
  const percents: number[] = []
  const ev: UploadEvents = {
    progress: (p) => percents.push(p),
    finishing: () => log.push('finishing'),
    done: (id) => log.push(`done:${id}`),
    failed: (m, retryable) => log.push(`failed:${retryable ? 'retry' : 'final'}:${m}`),
  }
  return { ev, log, percents }
}

const file = (size: number) =>
  new File([new Uint8Array(size).map((_, i) => i % 251)], 'talk.mp4', { type: 'video/mp4' })

const instant = { sleep: async () => undefined }

/** A put that stores the part it was sent, remembering how many ran at once. */
function storage(server: ReturnType<typeof fakeServer>) {
  const sent: number[] = []
  let running = 0
  let peak = 0
  const put: PutPart = async (url, body, onProgress) => {
    const n = Number(url.split('/').pop())
    running++
    peak = Math.max(peak, running)
    onProgress(body.size / 2)
    await Promise.resolve()
    running--
    sent.push(n)
    server.stored.set(n, body.size)
  }
  return { put, sent, peak: () => peak }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await settle()
  expect(cond()).toBe(true)
}

describe('a normal upload', () => {
  it('creates the project, sends every part once, and finishes', async () => {
    const server = fakeServer({ size: 25 })
    const store = storage(server)
    const { ev, log } = events()
    new Uploader(file(25), 120, ev, {
      api: server.api as never,
      put: store.put,
      ...instant,
    }).start()
    await until(() => log.includes('done:p1'))
    expect(store.sent.sort()).toEqual([1, 2, 3])
    expect(log).toEqual(['finishing', 'done:p1'])
    expect(server.calls.filter((c) => c.endsWith('/complete'))).toHaveLength(1)
    expect(server.api.post).toHaveBeenCalledWith('/projects', {
      fileName: 'talk.mp4',
      durationSec: 120,
    })
    expect(server.api.post).toHaveBeenCalledWith(
      '/uploads',
      expect.objectContaining({ projectId: 'p1', sizeBytes: 25, contentType: 'video/mp4' }),
    )
  })

  it('sends the right bytes in each part, including a short last one', async () => {
    const server = fakeServer({ size: 25 })
    const bodies = new Map<number, number[]>()
    const put: PutPart = async (url, body) => {
      const n = Number(url.split('/').pop())
      bodies.set(n, [...new Uint8Array(await body.arrayBuffer())])
      server.stored.set(n, body.size)
    }
    const { ev, log } = events()
    new Uploader(file(25), undefined, ev, { api: server.api as never, put, ...instant }).start()
    await until(() => log.includes('done:p1'))
    const whole = [...Array(25).keys()].map((i) => i % 251)
    expect(bodies.get(1)).toEqual(whole.slice(0, 10))
    expect(bodies.get(2)).toEqual(whole.slice(10, 20))
    expect(bodies.get(3)).toEqual(whole.slice(20, 25))
    expect(server.api.post).toHaveBeenCalledWith('/projects', { fileName: 'talk.mp4' })
  })

  it('never sends more than the allowed number of parts at once', async () => {
    const server = fakeServer({ size: 100 })
    const store = storage(server)
    const { ev, log } = events()
    new Uploader(file(100), undefined, ev, {
      api: server.api as never,
      put: store.put,
      concurrency: 3,
      ...instant,
    }).start()
    await until(() => log.includes('done:p1'))
    expect(store.sent).toHaveLength(10)
    expect(store.peak()).toBeLessThanOrEqual(3)
  })

  it('shows progress that only goes up and never reaches 100 before the server accepts the file', async () => {
    const server = fakeServer({ size: 50 })
    const store = storage(server)
    const { ev, log, percents } = events()
    new Uploader(file(50), undefined, ev, {
      api: server.api as never,
      put: store.put,
      concurrency: 1,
      ...instant,
    }).start()
    await until(() => log.includes('done:p1'))
    const beforeDone = percents.slice(0, -1)
    expect(Math.max(...beforeDone)).toBeLessThanOrEqual(99)
    expect(percents.at(-1)).toBe(100)
    for (let i = 1; i < percents.length; i++)
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
  })

  it('asks for links a few at a time, not one request per part', async () => {
    const server = fakeServer({ size: 100 })
    const store = storage(server)
    const { ev, log } = events()
    new Uploader(file(100), undefined, ev, {
      api: server.api as never,
      put: store.put,
      ...instant,
    }).start()
    await until(() => log.includes('done:p1'))
    expect(server.calls.filter((c) => c.endsWith('/parts')).length).toBeLessThan(10)
  })
})

describe('pausing and resuming', () => {
  it('sends only what storage is missing after a pause', async () => {
    const server = fakeServer({ size: 40 })
    const sent: number[] = []
    let hold: (() => void) | null = null
    const put: PutPart = async (url, body, _p, signal) => {
      const n = Number(url.split('/').pop())
      if (n === 3 && !sent.includes(3) && !hold) {
        // Part 3 hangs until the pause aborts it.
        await new Promise<void>((resolve, reject) => {
          hold = resolve
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
      sent.push(n)
      server.stored.set(n, body.size)
    }
    const { ev, log } = events()
    const up = new Uploader(file(40), undefined, ev, {
      api: server.api as never,
      put,
      concurrency: 1,
      ...instant,
    })
    up.start()
    await until(() => server.stored.size === 2)
    up.pause()
    await settle()
    expect([...server.stored.keys()].sort()).toEqual([1, 2])
    expect(log).toEqual([])

    up.resume()
    await until(() => log.includes('done:p1'))
    // Parts 1 and 2 were not sent again, and no second project or upload was made.
    expect(sent.filter((n) => n === 1)).toHaveLength(1)
    expect(sent.filter((n) => n === 2)).toHaveLength(1)
    expect(server.calls.filter((c) => c === 'POST /uploads')).toHaveLength(1)
    expect(server.calls.filter((c) => c === 'POST /projects')).toHaveLength(1)
    expect(server.calls).toContain('GET /uploads/u1')
  })

  it('a paused upload does not finish by itself', async () => {
    const server = fakeServer({ size: 30 })
    const store = storage(server)
    const { ev, log } = events()
    const up = new Uploader(file(30), undefined, ev, {
      api: server.api as never,
      put: store.put,
      ...instant,
    })
    up.start()
    up.pause()
    await settle()
    await settle()
    expect(log).not.toContain('done:p1')
  })
})

describe('finishing an earlier upload', () => {
  it('goes into the same project and does not create another', async () => {
    const server = fakeServer({ size: 20 })
    const store = storage(server)
    const { ev, log } = events()
    new Uploader(
      file(20),
      undefined,
      ev,
      { api: server.api as never, put: store.put, ...instant },
      'p1',
    ).start()
    await until(() => log.includes('done:p1'))
    expect(server.calls).not.toContain('POST /projects')
    expect(server.api.post).toHaveBeenCalledWith(
      '/uploads',
      expect.objectContaining({ projectId: 'p1' }),
    )
  })
})

describe('when something goes wrong', () => {
  it('tries a part again after a hiccup', async () => {
    const server = fakeServer({ size: 20 })
    let failures = 2
    const put: PutPart = async (url, body) => {
      if (failures-- > 0) throw new PartError(0)
      server.stored.set(Number(url.split('/').pop()), body.size)
    }
    const { ev, log } = events()
    new Uploader(file(20), undefined, ev, {
      api: server.api as never,
      put,
      concurrency: 1,
      ...instant,
    }).start()
    await until(() => log.includes('done:p1'))
    expect(server.stored.size).toBe(2)
  })

  it('gives up after repeated failures, says so plainly, and continues on Retry', async () => {
    const server = fakeServer({ size: 20 })
    let broken = true
    const put: PutPart = async (url, body) => {
      if (broken) throw new PartError(0)
      server.stored.set(Number(url.split('/').pop()), body.size)
    }
    const { ev, log } = events()
    const up = new Uploader(file(20), undefined, ev, {
      api: server.api as never,
      put,
      concurrency: 1,
      ...instant,
    })
    up.start()
    await until(() => log.some((l) => l.startsWith('failed')))
    expect(log.at(-1)).toMatch(/^failed:retry:Your connection dropped/)
    broken = false
    up.retry()
    await until(() => log.includes('done:p1'))
    expect(server.calls.filter((c) => c === 'POST /uploads')).toHaveLength(1)
  })

  it('asks for a fresh link when storage refuses an expired one', async () => {
    const server = fakeServer({ size: 10 })
    let refused = false
    const urls: string[] = []
    const put: PutPart = async (url, body) => {
      urls.push(url)
      if (!refused) {
        refused = true
        throw new PartError(403)
      }
      server.stored.set(1, body.size)
    }
    const { ev, log } = events()
    new Uploader(file(10), undefined, ev, { api: server.api as never, put, ...instant }).start()
    await until(() => log.includes('done:p1'))
    expect(server.calls.filter((c) => c.endsWith('/parts'))).toHaveLength(2)
  })

  it('a file the plan does not allow is final, and leaves no empty project behind', async () => {
    const server = fakeServer({ size: 20, limit: 'length' })
    const { ev, log } = events()
    new Uploader(file(20), 9000, ev, {
      api: server.api as never,
      put: storage(server).put,
      ...instant,
    }).start()
    await until(() => log.some((l) => l.startsWith('failed')))
    expect(log.at(-1)).toBe('failed:final:Free plan videos can be up to 10 minutes.')
    await until(() => server.calls.includes('DELETE /projects/p1'))
  })

  it('sends again the parts storage says are missing when the file is checked', async () => {
    const server = fakeServer({ size: 30 })
    const sent: number[] = []
    // Part 2 "arrives" but storage loses it, as the server will report at completion.
    const put: PutPart = async (url, body) => {
      const n = Number(url.split('/').pop())
      sent.push(n)
      if (n === 2 && sent.filter((x) => x === 2).length === 1) return
      server.stored.set(n, body.size)
    }
    const { ev, log } = events()
    new Uploader(file(30), undefined, ev, { api: server.api as never, put, ...instant }).start()
    await until(() => log.includes('done:p1'))
    expect(sent.filter((n) => n === 2)).toHaveLength(2)
    expect(sent.filter((n) => n === 1)).toHaveLength(1)
  })

  it('an upload that timed out starts a fresh one for the same project on Retry', async () => {
    const server = fakeServer({ size: 20, expireOnComplete: true })
    const store = storage(server)
    const { ev, log } = events()
    const up = new Uploader(file(20), undefined, ev, {
      api: server.api as never,
      put: store.put,
      ...instant,
    })
    up.start()
    await until(() => log.some((l) => l.startsWith('failed')))
    expect(log.at(-1)).toMatch(/^failed:retry:This upload timed out/)
    up.retry()
    await until(() => log.includes('done:p1'))
    expect(server.calls.filter((c) => c === 'POST /uploads')).toHaveLength(2)
    expect(server.calls.filter((c) => c === 'POST /projects')).toHaveLength(1)
  })
})

describe('cancelling', () => {
  it('stops sending, removes the upload and the empty project, and never reports done', async () => {
    const server = fakeServer({ size: 50 })
    const put: PutPart = (_u, _b, _p, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      )
    const { ev, log } = events()
    const up = new Uploader(file(50), undefined, ev, { api: server.api as never, put, ...instant })
    up.start()
    await until(() => server.calls.some((c) => c.endsWith('/parts')))
    up.cancel()
    await until(() => server.calls.includes('DELETE /projects/p1'))
    expect(server.calls).toContain('DELETE /uploads/u1')
    expect(log).toEqual([])
  })

  it('does not delete a finished upload', async () => {
    const server = fakeServer({ size: 10 })
    const store = storage(server)
    const { ev, log } = events()
    const up = new Uploader(file(10), undefined, ev, {
      api: server.api as never,
      put: store.put,
      ...instant,
    })
    up.start()
    await until(() => log.includes('done:p1'))
    up.cancel()
    await settle()
    expect(server.calls.some((c) => c.startsWith('DELETE'))).toBe(false)
  })
})
