/**
 * Keeps the editing session and the server's copy of the timeline in step.
 *
 * Every change is applied in the editor at once, then sent on in order. The server is the source of truth: it checks
 * each edit against the version the editor was looking at, and its answer is adopted. Because the editor hands out the
 * same ids for new clips as the server does, that answer almost never differs from what is already on screen.
 *
 * If a save fails the editor does not guess: it reloads the saved timeline and says so.
 */
import { api, ApiError } from '@/api/client'
import { toast } from '@/components/ui/Toast'
import type { ChatMessage, Timeline, TimelineOp, Version } from '@/types'
import {
  attachSyncer,
  patchBetween,
  useEditor,
  type LoadedSession,
  type OlderVersion,
  type Syncer,
} from './store'

/* ------------------------------ wire types ------------------------------ */

interface StateDto {
  version: number
  lastVersion: number
  canUndo: boolean
  canRedo: boolean
  timeline: Timeline
}

interface VersionDto {
  id: string
  n: number
  parentN: number | null
  author: 'you' | 'ai'
  label: string
  at: number
  editId?: string
  current: boolean
  onBranch: boolean
  redoable: boolean
}

interface CommitDto {
  version: VersionDto
  state: StateDto
}

interface DetailDto {
  version: VersionDto
  op: TimelineOp
  inverse: TimelineOp
  timeline: Timeline
}

interface HistoryDto {
  current: number
  versions: VersionDto[]
  hasMore: boolean
}

/** How many saved versions on each side of where the timeline is get loaded in full, so Undo and Redo work at once. */
const WINDOW = 12
const HISTORY_LIMIT = 100

const base = (projectId: string) => `/projects/${projectId}/timeline`

/* ------------------------------- helpers -------------------------------- */

/** Stable text for a value, whatever order its keys came in (the server's JSON storage reorders keys). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export const sameTimeline = (a: Timeline, b: Timeline) => canonical(a) === canonical(b)

const toVersion = (d: DetailDto): Version => ({
  id: `v_${d.version.n}`,
  n: d.version.n,
  author: d.version.author,
  label: d.version.label,
  at: d.version.at,
  op: d.op,
  inverse: d.inverse,
  after: d.timeline,
  editId: d.version.editId,
  serverN: d.version.n,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An edit the assistant planned is applied by the server from its own saved plan (same op, same label), not from what
 * the editor sends. Anything else, including taking such an edit back, is an ordinary save of the editor's op.
 */
const isServerPlan = (v: Version) =>
  v.author === 'ai' && !!v.editId && !v.undoesEditId && UUID.test(v.editId)

const transient = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500)

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!transient(e) || attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 1)))
    }
  }
}

/* ------------------------------- loading -------------------------------- */

/** Reads the saved timeline and enough of its history to make Undo and Redo work straight away. */
export async function loadSession(
  projectId: string,
): Promise<{ data: LoadedSession; version: number }> {
  const [state, history] = await Promise.all([
    api.get<StateDto>(base(projectId)),
    api.get<HistoryDto>(`${base(projectId)}/history?limit=${HISTORY_LIMIT}`),
  ])
  const byN = (a: VersionDto, b: VersionDto) => a.n - b.n
  const behind = history.versions
    .filter((v) => v.onBranch || v.current)
    .sort(byN)
    .slice(-WINDOW)
  const ahead = history.versions
    .filter((v) => v.redoable)
    .sort(byN)
    .slice(0, WINDOW)
  const wanted = [...behind, ...ahead]
  const details = await Promise.all(
    wanted.map((v) => api.get<DetailDto>(`${base(projectId)}/versions/${v.n}`)),
  )
  const versions = details.map(toVersion)
  const headAt = versions.findIndex((v) => v.serverN === state.version)
  if (!versions.length) {
    versions.push({
      id: `v_${state.version}`,
      n: state.version,
      author: 'you',
      label: 'Original upload',
      at: Date.now(),
      op: { type: 'batch', ops: [] },
      inverse: { type: 'batch', ops: [] },
      after: state.timeline,
      serverN: state.version,
    })
  }
  const loaded = new Set(wanted.map((v) => v.n))
  const older: OlderVersion[] = history.versions
    .filter((v) => !loaded.has(v.n))
    .sort((a, b) => b.n - a.n)
    .map((v) => ({ n: v.n, author: v.author, label: v.label, at: v.at }))
  return {
    data: {
      versions,
      cursor: Math.max(0, headAt),
      counter: state.lastVersion,
      older,
    },
    version: state.version,
  }
}

/* -------------------------------- syncing ------------------------------- */

class Remote implements Syncer {
  readonly projectId: string
  /** The server version the next save is based on. */
  version: number
  /** Everything queued runs after this. */
  tail: Promise<void> = Promise.resolve()
  private epoch = 0
  private pending = 0
  private failed = false
  private warn = (e: BeforeUnloadEvent) => e.preventDefault()

  constructor(projectId: string, version: number) {
    this.projectId = projectId
    this.version = version
  }

  commit(version: Version, before: Timeline) {
    this.enqueue(async () => {
      const res = await api.post<CommitDto>(
        ...(isServerPlan(version)
          ? ([
              `/projects/${this.projectId}/plans/${version.editId}/apply`,
              { baseVersion: this.version },
            ] as const)
          : ([
              `${base(this.projectId)}/ops`,
              {
                baseVersion: this.version,
                ops: [version.op],
                label: version.label,
                author: version.author,
                ...(version.editId ? { editId: version.editId } : {}),
                ...(version.undoesEditId && UUID.test(version.undoesEditId)
                  ? { undoesEditId: version.undoesEditId }
                  : {}),
              },
            ] as const)),
      )
      this.version = res.state.version
      const store = useEditor.getState()
      const mine = [...store.versions, ...store.archived].find((v) => v.id === version.id)
      if (!mine) return
      if (res.version.n !== version.n || !sameTimeline(mine.after, res.state.timeline)) {
        // The server's answer wins. The inverse is rebuilt from it so undoing this edit undoes what is really there.
        store.adoptVersion(version.id, {
          after: res.state.timeline,
          inverse: patchBetween(res.state.timeline, before),
          serverN: res.version.n,
        })
      } else {
        store.adoptVersion(version.id, { serverN: res.version.n })
      }
    })
  }

  undo() {
    this.enqueue(async () => {
      const state = await api.post<StateDto>(`${base(this.projectId)}/undo`, {
        baseVersion: this.version,
      })
      this.version = state.version
    })
  }

  redo() {
    this.enqueue(async () => {
      const state = await api.post<StateDto>(`${base(this.projectId)}/redo`, {
        baseVersion: this.version,
      })
      this.version = state.version
    })
  }

  /** Runs one save after the ones before it. A save that cannot be completed reloads what the server has. */
  private enqueue(task: () => Promise<void>) {
    const epoch = this.epoch
    this.pending++
    this.failed = false
    window.addEventListener('beforeunload', this.warn)
    useEditor.getState().setSaveState('saving')
    this.tail = this.tail.then(async () => {
      try {
        if (epoch === this.epoch) await withRetry(task)
      } catch (e) {
        if (epoch === this.epoch) await this.recover(e)
      } finally {
        this.pending--
        if (!this.pending) this.settled()
      }
    })
  }

  /** The queue is empty. Check that where the editor is matches where the server is. */
  private settled() {
    window.removeEventListener('beforeunload', this.warn)
    const s = useEditor.getState()
    if (s.projectId !== this.projectId) return
    const here = s.versions[s.cursor]
    if (!this.failed && here?.serverN !== undefined && here.serverN !== this.version) {
      void this.reload('Your edit history was out of step, so it was reloaded.')
      return
    }
    s.setSaveState(this.failed ? 'error' : 'idle')
  }

  private async recover(e: unknown) {
    this.epoch++
    if (e instanceof ApiError && e.status === 401) {
      // The session ended; the app is already sending the person to log in.
      this.failed = true
      return
    }
    const reason =
      e instanceof ApiError && e.code === 'VERSION_CONFLICT'
        ? 'This project was changed somewhere else, so you are now seeing the latest version.'
        : e instanceof ApiError && e.code === 'STALE_PLAN'
          ? 'Your edit changed since the assistant made that plan, and it no longer fits. Ask again for a fresh one.'
          : e instanceof ApiError && e.code === 'INVALID_OP'
            ? `That change could not be saved (${e.message}). The last saved version is back.`
            : 'Your last change could not be saved. The last saved version is back.'
    await this.reload(reason)
  }

  /** Throws away what is not saved and shows what is. */
  async reload(reason: string) {
    this.epoch++
    try {
      const { data, version } = await loadSession(this.projectId)
      this.version = version
      const s = useEditor.getState()
      if (s.projectId === this.projectId) s.load(this.projectId, data, s.messages)
      toast({ title: 'Reloaded the saved version', description: reason, tone: 'info' })
    } catch {
      this.failed = true
      useEditor.getState().setSaveState('error')
      toast({
        title: 'Changes are not being saved',
        description: 'Check your connection, then reload the page to carry on.',
        tone: 'error',
      })
    }
  }

  /** Waits for every queued save. */
  idle() {
    return this.tail
  }
}

let remote: Remote | null = null

/**
 * Opens a project's editing session from the server and starts saving to it. Anything still being saved from an
 * earlier visit finishes first, so the session starts from the latest saved version.
 */
export async function openRemote(projectId: string, opening: ChatMessage[]) {
  await remote?.idle()
  attachSyncer(null)
  const { data, version } = await loadSession(projectId)
  remote = new Remote(projectId, version)
  useEditor.getState().load(projectId, data, opening)
  attachSyncer(remote)
}

/** Resolves once every change made so far has been saved. Call before anything that reads the saved timeline. */
export async function flushSaves() {
  await remote?.idle()
}

/** Detaches the editor from the server (leaving the project). Saves already queued still complete. */
export function closeRemote() {
  attachSyncer(null)
}

/* ----------------------- older edits (History panel) ----------------------- */

/** Shows an older saved version without changing the edit. */
export async function peekOlder(n: number) {
  const s = useEditor.getState()
  if (!s.projectId) return
  const d = await api.get<DetailDto>(`${base(s.projectId)}/versions/${n}`)
  useEditor.setState({ preview: { kind: 'version', id: `v_${n}`, timeline: d.timeline } })
}

/** Becomes an older saved version, as a new version, so nothing is lost. */
export async function restoreOlder(
  n: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = useEditor.getState()
  const r = remote
  if (!s.projectId || !r || r.projectId !== s.projectId)
    return { ok: false, error: 'Not connected.' }
  // Let pending saves land first so the restore is based on the latest version.
  await r.idle()
  const before = s.versions[s.cursor]!.after
  try {
    const res = await withRetry(() =>
      api.post<CommitDto>(`${base(r.projectId)}/restore`, { baseVersion: r.version, versionN: n }),
    )
    r.version = res.state.version
    const v: Version = {
      id: `v_${res.version.n}`,
      n: res.version.n,
      author: res.version.author,
      label: res.version.label,
      at: res.version.at,
      op: patchBetween(before, res.state.timeline),
      inverse: patchBetween(res.state.timeline, before),
      after: res.state.timeline,
      serverN: res.version.n,
    }
    useEditor.getState().pushRemote(v)
    return { ok: true }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
      void r.reload(
        'This project was changed somewhere else, so you are now seeing the latest version.',
      )
    return { ok: false, error: e instanceof Error ? e.message : 'Could not restore that version.' }
  }
}
