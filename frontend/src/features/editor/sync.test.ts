import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '@/api/client'
import type { Timeline, TimelineOp } from '@/types'
import { fixture } from '@/lib/timeline/fixtures'
import { applyOp, sequentialIds } from '@lypcut/timeline-core'
import { trackItems } from '@lypcut/timeline-core'

vi.mock('@/components/ui/Toast', () => ({ toast: vi.fn() }))
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ClientModule>('@/api/client')
  return {
    ...actual,
    api: {
      get: (path: string) => server.handle('GET', path),
      post: (path: string, body?: unknown) => server.handle('POST', path, body),
    },
  }
})

import { ApiError } from '@/api/client'
import { toast } from '@/components/ui/Toast'
import { attachSyncer, useEditor } from './store'
import { closeRemote, openRemote, peekOlder, restoreOlder, sameTimeline } from './sync'

/* A model of the backend's timeline API, using the same engine and id scheme. */
interface Row {
  n: number
  parentN: number | null
  author: 'you' | 'ai'
  label: string
  at: number
  op: TimelineOp
  inverse: TimelineOp
  snapshot: Timeline
  editId?: string
}

class FakeServer {
  rows = new Map<number, Row>()
  current = 0
  last = 0
  redo: number[] = []
  log: string[] = []
  /** What was sent with each save, in order. */
  bodies: Array<{ line: string; body: Record<string, unknown> }> = []
  /** Plans the assistant has made, by id. */
  plans = new Map<string, { title: string; op: TimelineOp }>()
  /** Failures to hand out before behaving, keyed by the start of the request line. */
  failures: Array<{ match: string; error: () => Error; times: number }> = []
  delayMs = 0

  reset(tl: Timeline) {
    this.rows.clear()
    this.current = 0
    this.last = 0
    this.redo = []
    this.log = []
    this.bodies = []
    this.plans.clear()
    this.failures = []
    this.delayMs = 0
    this.rows.set(0, {
      n: 0,
      parentN: null,
      author: 'you',
      label: 'Original upload',
      at: 1,
      op: { type: 'batch', ops: [] },
      inverse: { type: 'batch', ops: [] },
      snapshot: tl,
    })
  }

  private get head() {
    return this.rows.get(this.current)!
  }
  private state() {
    return {
      version: this.current,
      lastVersion: this.last,
      canUndo: this.head.parentN !== null,
      canRedo: this.redo.length > 0,
      timeline: this.head.snapshot,
    }
  }
  private dto(r: Row) {
    const branch = new Set<number>()
    for (let x: number | null = this.current; x !== null; x = this.rows.get(x)!.parentN)
      branch.add(x)
    return {
      id: `ver_${r.n}`,
      n: r.n,
      parentN: r.parentN,
      author: r.author,
      label: r.label,
      at: r.at,
      editId: r.editId,
      current: r.n === this.current,
      onBranch: branch.has(r.n),
      redoable: this.redo.includes(r.n),
    }
  }
  private checkBase(body: unknown) {
    const base = (body as { baseVersion: number }).baseVersion
    if (base !== this.current)
      throw new ApiError('Changed elsewhere.', 409, undefined, 'VERSION_CONFLICT', {
        currentVersion: this.current,
      })
  }
  private add(row: Omit<Row, 'n' | 'parentN'>) {
    const n = ++this.last
    this.rows.set(n, { ...row, n, parentN: this.current })
    this.current = n
    this.redo = []
    return this.rows.get(n)!
  }

  async handle(method: string, path: string, body?: unknown): Promise<unknown> {
    const line = `${method} ${path.replace('/projects/p1/timeline', '')}`
    this.log.push(
      line +
        (body && 'baseVersion' in (body as object)
          ? ` @${(body as { baseVersion: number }).baseVersion}`
          : ''),
    )
    if (body && method === 'POST') this.bodies.push({ line, body: body as Record<string, unknown> })
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    const f = this.failures.find((x) => line.startsWith(x.match) && x.times > 0)
    if (f) {
      f.times--
      throw f.error()
    }
    const applied = /^POST \/projects\/p1\/plans\/([^/]+)\/apply$/.exec(line)
    if (applied) {
      const plan = this.plans.get(applied[1]!)
      if (!plan) throw new ApiError('Not found.', 404, undefined, 'NOT_FOUND')
      return this.handle('POST', '/projects/p1/timeline/ops', {
        baseVersion: (body as { baseVersion: number }).baseVersion,
        ops: [plan.op],
        label: plan.title,
        author: 'ai',
        editId: applied[1],
      })
    }
    if (line === 'GET ') return this.state()
    if (line.startsWith('GET /history'))
      return {
        current: this.current,
        versions: [...this.rows.values()].sort((a, b) => b.n - a.n).map((r) => this.dto(r)),
        hasMore: false,
      }
    const detail = /^GET \/versions\/(\d+)$/.exec(line)
    if (detail) {
      const r = this.rows.get(Number(detail[1]))
      if (!r) throw new ApiError('Not found.', 404)
      return { version: this.dto(r), op: r.op, inverse: r.inverse, timeline: r.snapshot }
    }
    if (line === 'POST /ops') {
      this.checkBase(body)
      const b = body as { ops: TimelineOp[]; label: string; author: 'you' | 'ai'; editId?: string }
      const before = this.head.snapshot
      const newId = sequentialIds(`i_v${this.last + 1}_`)
      let cur = before
      for (const op of b.ops) {
        try {
          cur = applyOp(cur, op, { newId }).timeline
        } catch (e) {
          throw new ApiError((e as Error).message, 422, undefined, 'INVALID_OP')
        }
      }
      const row = this.add({
        author: b.author,
        label: b.label,
        at: 2,
        op: b.ops[0]!,
        inverse: { type: 'batch', ops: [] },
        snapshot: cur,
        editId: b.editId,
      })
      return { version: this.dto(row), state: this.state() }
    }
    if (line === 'POST /undo') {
      this.checkBase(body)
      this.redo.push(this.current)
      this.current = this.head.parentN!
      return this.state()
    }
    if (line === 'POST /redo') {
      this.checkBase(body)
      this.current = this.redo.pop()!
      return this.state()
    }
    if (line === 'POST /restore') {
      this.checkBase(body)
      const target = this.rows.get((body as { versionN: number }).versionN)!
      const row = this.add({
        author: 'you',
        label: `Restored: ${target.label}`,
        at: 3,
        op: { type: 'batch', ops: [] },
        inverse: { type: 'batch', ops: [] },
        snapshot: target.snapshot,
      })
      return { version: this.dto(row), state: this.state() }
    }
    throw new Error(`unexpected ${line}`)
  }
}

const server = new FakeServer()
const tl0 = fixture().timeline
const video = trackItems(tl0, 'trk_video')

const settle = async (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function drained() {
  for (let i = 0; i < 50; i++) {
    await settle(5)
    if (useEditor.getState().saveState !== 'saving') return
  }
  throw new Error('saves never finished')
}

const store = () => useEditor.getState()
const head = () => store().versions[store().cursor]!
const edit = (op: TimelineOp, label = 'Edit') => {
  const res = store().commit(op, { author: 'you', label })
  if (!res.ok) throw new Error(res.error)
  return res.version
}
/** The first clip, a little shorter each time. */
const shrink = (i: number) => trimEnd(video[0]!.id, video[0]!.start + video[0]!.duration - 0.05 * i)
const trimEnd = (itemId: string, to: number): TimelineOp => ({
  type: 'trim',
  itemId,
  edge: 'end',
  to,
})

beforeEach(() => {
  vi.mocked(toast).mockClear()
  server.reset(tl0)
  store().reset()
})
afterEach(() => {
  closeRemote()
  vi.useRealTimers()
})

describe('opening a project from the server', () => {
  it('shows the saved timeline, with the version numbering of the server', async () => {
    await openRemote('p1', [])
    expect(store().projectId).toBe('p1')
    expect(head().after).toEqual(tl0)
    expect(store().counter).toBe(0)
    expect(store().saveState).toBe('idle')
    expect(server.log.slice(0, 2).sort()).toEqual(['GET ', 'GET /history?limit=100'])
  })

  it('brings back enough history for Undo and Redo to work straight away', async () => {
    await openRemote('p1', [])
    for (let i = 1; i <= 4; i++) edit(shrink(i), `Trim ${i}`)
    await drained()
    store().undo()
    store().undo()
    await drained()
    // A fresh visit: the browser starts over, the server remembers.
    store().reset()
    await openRemote('p1', [])
    expect(store().versions.map((v) => v.n)).toEqual([0, 1, 2, 3, 4])
    expect(head().n).toBe(2)
    expect(store().cursor).toBe(2)
    expect(store().counter).toBe(4)
    expect(store().versions[3]!.after).toEqual(server.rows.get(3)!.snapshot)
    store().undo()
    expect(head().n).toBe(1)
    await drained()
    expect(server.current).toBe(1)
  })

  it('lists versions beyond the loaded window as saved edits that can be restored', async () => {
    await openRemote('p1', [])
    for (let i = 1; i <= 20; i++) edit(shrink(i), `Trim ${i}`)
    await drained()
    store().reset()
    await openRemote('p1', [])
    expect(store().versions).toHaveLength(12)
    expect(store().versions.at(-1)!.n).toBe(20)
    expect(store().older.map((o) => o.n)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(store().older[0]!.label).toBe('Trim 8')
  })
})

describe('saving edits', () => {
  it('sends an edit with the version it was based on, and marks it saved', async () => {
    await openRemote('p1', [])
    expect(store().saveState).toBe('idle')
    const v = edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Shorter')
    expect(store().saveState).toBe('saving')
    await drained()
    expect(server.log).toContain('POST /ops @0')
    expect(store().saveState).toBe('idle')
    expect(server.rows.get(1)!.label).toBe('Shorter')
    expect(store().versions.find((x) => x.id === v.id)!.serverN).toBe(1)
  })

  it('sends several quick edits in order, each based on the one before', async () => {
    server.delayMs = 15
    await openRemote('p1', [])
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'One')
    edit(trimEnd(video[0]!.id, video[0]!.start + 9), 'Two')
    edit(trimEnd(video[0]!.id, video[0]!.start + 8), 'Three')
    await drained()
    expect(server.log.filter((l) => l.startsWith('POST /ops'))).toEqual([
      'POST /ops @0',
      'POST /ops @1',
      'POST /ops @2',
    ])
    expect(server.last).toBe(3)
  })

  it('gives new clips the ids the server gives them, so the next edit can name them at once', async () => {
    server.delayMs = 10
    await openRemote('p1', [])
    const clip = video[0]!
    // Split, then immediately trim the clip the split created, before the server has answered.
    edit({ type: 'split', itemId: clip.id, at: clip.start + 8 }, 'Split')
    const created = Object.keys(head().after.items).find((id) => id.startsWith('i_v1_'))!
    expect(created).toBe('i_v1_1')
    edit(trimEnd(created, clip.start + 12), 'Trim the new half')
    await drained()
    expect(toast).not.toHaveBeenCalled()
    expect(server.last).toBe(2)
    expect(sameTimeline(head().after, server.rows.get(2)!.snapshot)).toBe(true)
  })

  it('keeps ids in step after an undo too (a new edit still takes the next version number)', async () => {
    await openRemote('p1', [])
    const clip = video[0]!
    edit(trimEnd(clip.id, clip.start + 10), 'A')
    store().undo()
    edit({ type: 'split', itemId: clip.id, at: clip.start + 5 }, 'Split')
    await drained()
    expect(server.last).toBe(2)
    expect(Object.keys(head().after.items)).toContain('i_v2_1')
    expect(sameTimeline(head().after, server.rows.get(2)!.snapshot)).toBe(true)
    expect(toast).not.toHaveBeenCalled()
  })

  it('adopts the server when its answer differs from what the editor worked out', async () => {
    await openRemote('p1', [])
    const clip = video[0]!
    const wrong = vi.spyOn(server, 'handle')
    const v = edit(trimEnd(clip.id, clip.start + 10), 'Shorter')
    // Pretend the editor drifted: change its copy before the answer arrives.
    useEditor.getState().adoptVersion(v.id, {
      after: {
        ...v.after,
        items: { ...v.after.items, [clip.id]: { ...v.after.items[clip.id]!, label: 'drifted' } },
      },
    })
    await drained()
    wrong.mockRestore()
    expect(head().after.items[clip.id]!.label).not.toBe('drifted')
    expect(sameTimeline(head().after, server.rows.get(1)!.snapshot)).toBe(true)
  })
})

describe('undo and redo', () => {
  it('are saved as undo and redo, not as new edits', async () => {
    await openRemote('p1', [])
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'One')
    await drained()
    store().undo()
    await drained()
    store().redo()
    await drained()
    expect(server.log.filter((l) => /undo|redo/.test(l))).toEqual([
      'POST /undo @1',
      'POST /redo @0',
    ])
    expect(server.last).toBe(1)
    expect(server.current).toBe(1)
  })

  it('a quick undo straight after an edit lands in the right order', async () => {
    server.delayMs = 10
    await openRemote('p1', [])
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'One')
    store().undo()
    await drained()
    expect(server.log.filter((l) => l.startsWith('POST'))).toEqual([
      'POST /ops @0',
      'POST /undo @1',
    ])
    expect(server.current).toBe(0)
  })
})

describe('when saving fails', () => {
  it('reloads the saved version and says why, when the server refuses an edit', async () => {
    await openRemote('p1', [])
    server.failures.push({
      match: 'POST /ops',
      times: 1,
      error: () => new ApiError('Clips can’t overlap.', 422, undefined, 'INVALID_OP'),
    })
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Nope')
    await drained()
    expect(head().n).toBe(0)
    expect(store().versions).toHaveLength(1)
    expect(head().after).toEqual(tl0)
    expect(store().saveState).toBe('idle')
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Reloaded the saved version' }),
    )
  })

  it('reloads when the project was changed somewhere else', async () => {
    await openRemote('p1', [])
    // Another tab saves a version.
    server.current = 0
    await server.handle('POST', '/projects/p1/timeline/ops', {
      baseVersion: 0,
      ops: [trimEnd(video[1]!.id, video[1]!.start + 5)],
      label: 'From another tab',
      author: 'you',
    })
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Mine')
    await drained()
    expect(head().n).toBe(1)
    expect(head().label).toBe('From another tab')
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('changed somewhere else') }),
    )
  })

  it('drops the edits queued behind a failed one instead of sending them on a broken base', async () => {
    server.delayMs = 5
    await openRemote('p1', [])
    server.failures.push({
      match: 'POST /ops',
      times: 1,
      error: () => new ApiError('Refused.', 422, undefined, 'INVALID_OP'),
    })
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Bad')
    edit(trimEnd(video[0]!.id, video[0]!.start + 9), 'Depends on bad')
    await drained()
    expect(server.log.filter((l) => l.startsWith('POST /ops'))).toHaveLength(1)
    expect(server.last).toBe(0)
  })

  it('retries a hiccup before giving up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openRemote('p1', [])
    server.failures.push({ match: 'POST /ops', times: 2, error: () => new ApiError('Down.', 503) })
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Persistent')
    await vi.advanceTimersByTimeAsync(5000)
    await drained()
    expect(server.log.filter((l) => l.startsWith('POST /ops'))).toHaveLength(3)
    expect(server.last).toBe(1)
    expect(toast).not.toHaveBeenCalled()
  })

  it('says plainly that nothing is being saved when the server cannot be reached at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openRemote('p1', [])
    server.failures.push({ match: 'POST /ops', times: 9, error: () => new ApiError('Offline.', 0) })
    server.failures.push({ match: 'GET ', times: 9, error: () => new ApiError('Offline.', 0) })
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Offline edit')
    await vi.advanceTimersByTimeAsync(20_000)
    await drained()
    expect(store().saveState).toBe('error')
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Changes are not being saved' }),
    )
  })
})

describe('earlier saved edits', () => {
  async function withHistory() {
    await openRemote('p1', [])
    for (let i = 1; i <= 15; i++) edit(shrink(i), `Trim ${i}`)
    await drained()
    store().reset()
    await openRemote('p1', [])
  }

  it('can be viewed without changing the edit', async () => {
    await withHistory()
    const before = head().after
    await peekOlder(1)
    expect(store().preview?.kind).toBe('version')
    expect(store().preview?.timeline).toEqual(server.rows.get(1)!.snapshot)
    expect(head().after).toBe(before)
  })

  it('can be restored, as a new version on top, using the server', async () => {
    await withHistory()
    const res = await restoreOlder(1)
    expect(res).toEqual({ ok: true })
    expect(server.log).toContain('POST /restore @15')
    expect(head().n).toBe(16)
    expect(head().label).toBe('Restored: Trim 1')
    expect(sameTimeline(head().after, server.rows.get(1)!.snapshot)).toBe(true)
    // It is an ordinary version now: undo goes back to where the edit was.
    store().undo()
    expect(head().n).toBe(15)
    await drained()
    expect(server.current).toBe(15)
  })

  it('waits for pending saves first, so the restore is based on the latest version', async () => {
    await withHistory()
    server.delayMs = 10
    edit(trimEnd(video[1]!.id, video[1]!.start + 5), 'Pending')
    const res = await restoreOlder(1)
    expect(res.ok).toBe(true)
    expect(
      server.log
        .filter((l) => l.startsWith('POST /ops') || l.startsWith('POST /restore'))
        .slice(-2),
    ).toEqual(['POST /ops @15', 'POST /restore @16'])
  })

  it('reloads if the project changed elsewhere meanwhile', async () => {
    await withHistory()
    server.failures.push({
      match: 'POST /restore',
      times: 1,
      error: () => new ApiError('Changed.', 409, undefined, 'VERSION_CONFLICT'),
    })
    const res = await restoreOlder(1)
    expect(res.ok).toBe(false)
  })
})

describe('leaving', () => {
  it('stops saving once detached, and does nothing to the server', async () => {
    await openRemote('p1', [])
    closeRemote()
    edit(trimEnd(video[0]!.id, video[0]!.start + 10), 'Local only')
    await settle(20)
    expect(server.log.filter((l) => l.startsWith('POST'))).toEqual([])
    attachSyncer(null)
  })
})

describe('edits the assistant planned', () => {
  const PLAN_ID = '01a16ef1-c3ef-7fbc-a676-db6cf5e500f5'
  const plan = (id: string, op: TimelineOp) => ({
    id,
    title: 'Shorter intro',
    description: '',
    op,
    strip: [],
    summary: [],
  })

  it('are applied by the server from its own saved plan, with the plan’s id', async () => {
    await openRemote('p1', [])
    const op = trimEnd(video[0]!.id, video[0]!.start + 10)
    server.plans.set(PLAN_ID, { title: 'Shorter intro', op })
    store().registerEdit(plan(PLAN_ID, op))
    expect(store().applyEdit(PLAN_ID).ok).toBe(true)
    await drained()
    expect(server.log).toContain(`POST /projects/p1/plans/${PLAN_ID}/apply @0`)
    expect(server.rows.get(1)).toMatchObject({
      author: 'ai',
      editId: PLAN_ID,
      label: 'Shorter intro',
    })
    expect(store().versions.find((v) => v.editId === PLAN_ID)!.serverN).toBe(1)
  })

  it('an edit from the stand-in planner (not a server plan) is saved as an ordinary edit', async () => {
    await openRemote('p1', [])
    store().registerEdit(plan('edit_ab12', trimEnd(video[0]!.id, video[0]!.start + 10)))
    expect(store().applyEdit('edit_ab12').ok).toBe(true)
    await drained()
    expect(server.log).toContain('POST /ops @0')
    expect(server.rows.get(1)).toMatchObject({ author: 'ai', editId: 'edit_ab12' })
  })

  it('taking one back out of order is saved as an ordinary edit that says which plan it undoes', async () => {
    await openRemote('p1', [])
    const op = trimEnd(video[0]!.id, video[0]!.start + 10)
    server.plans.set(PLAN_ID, { title: 'Shorter intro', op })
    store().registerEdit(plan(PLAN_ID, op))
    store().applyEdit(PLAN_ID)
    // A later edit of something else, so undoing the plan is no longer a plain Undo.
    edit(trimEnd(video[1]!.id, video[1]!.start + video[1]!.duration - 1), 'Later')
    await drained()
    expect(store().undoEdit(PLAN_ID).ok).toBe(true)
    await drained()
    const undo = server.bodies.filter((b) => b.line === 'POST /ops').at(-1)!
    expect(undo.body).toMatchObject({ author: 'you', undoesEditId: PLAN_ID })
    expect(undo.body).not.toHaveProperty('editId')
  })

  it('a plan that no longer fits reloads the saved version and tells the person to ask again', async () => {
    await openRemote('p1', [])
    const op = trimEnd(video[0]!.id, video[0]!.start + 10)
    server.plans.set(PLAN_ID, { title: 'Shorter intro', op })
    server.failures.push({
      match: 'POST /projects/p1/plans',
      times: 1,
      error: () => new ApiError('Changed.', 409, undefined, 'STALE_PLAN'),
    })
    store().registerEdit(plan(PLAN_ID, op))
    store().applyEdit(PLAN_ID)
    await drained()
    expect(head().n).toBe(0)
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Reloaded the saved version',
        description: expect.stringContaining('Ask again'),
      }),
    )
  })
})
