import { create } from 'zustand'
import type {
  ChatMessage,
  EditPlan,
  Timeline,
  TimelineOp,
  TimelineSettings,
  Version,
} from '@/types'
import {
  applyOp,
  changedItemIds,
  inverseConflicts,
  OpError,
  sequentialIds,
} from '@lypcut/timeline-core'
import { onSignOut } from '@/lib/session'
import { timeAtSource } from '@lypcut/timeline-core'

/**
 * Editor state. Everything about the edit is a list of versions; the timeline you see is
 * `versions[cursor].after`. The AI and the user both change it only by committing a TimelineOp,
 * so Undo, Redo, History and "undo that AI action" all come from the same list.
 */

export interface EditRecord {
  plan: EditPlan
  /** The version this edit created when applied. Kept after an undo so it can be re-applied. */
  versionId?: string
  /** The version that took it back, when it was undone out of order. */
  undoneVersionId?: string
}

export type EditStatus = 'proposed' | 'previewing' | 'applied' | 'undone'

export interface Landed {
  key: number
  added: string[]
  /** Reshaped (trimmed, split, retimed inside). These leap. */
  changed: string[]
  /** Only slid along the timeline, for example after a ripple. These slide. */
  moved: string[]
  /** Timeline times where a cut just closed. */
  cuts: number[]
}

export type Preview = { kind: 'edit' | 'version'; id: string; timeline: Timeline } | null

/** Something another panel wants the chat to deal with (a Reel from a search result, say). */
export interface Ask {
  id: number
  text: string
  reel?: { srcFrom: number; srcTo: number; title: string }
}

export interface CommitMeta {
  author: 'you' | 'ai'
  label: string
  editId?: string
  undoesEditId?: string
}

export type CommitResult = { ok: true; version: Version } | { ok: false; error: string }

export type SaveState = 'idle' | 'saving' | 'error'

/** An edit in the server's history that is not loaded into this session. It can be viewed and restored from the server. */
export interface OlderVersion {
  n: number
  author: 'you' | 'ai'
  label: string
  at: number
}

/**
 * Saves the session to the server. The store applies every change locally first, so the editor never waits, and
 * hands it to the syncer, which sends it on in order. Absent against the mock.
 */
export interface Syncer {
  commit: (version: Version, before: Timeline) => void
  undo: () => void
  redo: () => void
}

let syncer: Syncer | null = null
export function attachSyncer(next: Syncer | null) {
  syncer = next
}

interface Persisted {
  versions: Version[]
  cursor: number
  archived: Version[]
  edits: Record<string, EditRecord>
  messages: ChatMessage[]
  counter: number
}

interface EditorState extends Persisted {
  projectId: string | null
  preview: Preview
  selection: string[]
  /** Highlight what a previewed version changed. */
  compare: boolean
  query: string
  ask: Ask | null
  landed: Landed
  thinking: boolean
  /** Playback is muted by default so a video never starts loud in a quiet room. */
  muted: boolean
  saveState: SaveState
  /** Server history that is not in `versions`: other branches and edits from before this session's window. */
  older: OlderVersion[]

  open: (projectId: string, initial: Timeline, opening: ChatMessage[]) => void
  commit: (op: TimelineOp, meta: CommitMeta) => CommitResult
  undo: () => void
  redo: () => void
  restore: (versionId: string) => CommitResult
  peekVersion: (versionId: string | null) => void
  registerEdit: (plan: EditPlan) => void
  previewEdit: (editId: string | null) => string | null
  applyEdit: (editId: string) => CommitResult
  undoEdit: (editId: string) => { ok: true } | { ok: false; conflict: boolean; error: string }
  setSelection: (ids: string[]) => void
  setCompare: (v: boolean) => void
  setQuery: (q: string) => void
  askChat: (a: Omit<Ask, 'id'>) => void
  clearAsk: () => void
  addMessage: (m: ChatMessage) => void
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void
  setThinking: (v: boolean) => void
  setMuted: (v: boolean) => void
  reset: () => void
  /** Replaces the session with one built from the server. Chat and the edit cards are kept when it is the same project. */
  load: (projectId: string, data: LoadedSession, opening: ChatMessage[]) => void
  /** The server answered for a version saved earlier: take its numbering, and its timeline if it differs. */
  adoptVersion: (id: string, patch: Partial<Pick<Version, 'after' | 'inverse' | 'serverN'>>) => void
  /** Adds a version the server created (a restore of an older edit) the way a local commit would. */
  pushRemote: (version: Version) => void
  setSaveState: (s: SaveState) => void
  setOlder: (list: OlderVersion[]) => void
}

export interface LoadedSession {
  versions: Version[]
  cursor: number
  counter: number
  older: OlderVersion[]
}

const sessions = new Map<string, Persisted>()
const NO_LANDING: Landed = { key: 0, added: [], changed: [], moved: [], cuts: [] }
const MAX_CUTS = 40

function makeRoot(initial: Timeline): Version {
  const nothing: TimelineOp = { type: 'batch', ops: [] }
  return {
    id: 'v_0',
    n: 0,
    author: 'you',
    label: 'Original upload',
    at: Date.now(),
    op: nothing,
    inverse: nothing,
    after: initial,
  }
}

/** Source positions where this op closed a gap, so the cut-line can flash there. */
function cutSources(op: TimelineOp, out: number[] = []): number[] {
  if (op.type === 'cutSource') out.push(op.srcTo)
  else if (op.type === 'batch') op.ops.forEach((o) => cutSources(o, out))
  return out
}

function rippleTimes(op: TimelineOp, out: number[] = []): number[] {
  if (op.type === 'rippleDelete') out.push(op.from)
  else if (op.type === 'batch') op.ops.forEach((o) => rippleTimes(o, out))
  return out
}

/** A patch that turns `from` into `to`. This is how Restore stays non-destructive. */
export function patchBetween(from: Timeline, to: Timeline): Extract<TimelineOp, { type: 'patch' }> {
  const upsert = Object.values(to.items).filter((it) => from.items[it.id] !== it)
  const remove = Object.keys(from.items).filter((id) => !to.items[id])
  const settings: Partial<TimelineSettings> = {}
  let any = false
  for (const k of new Set([...Object.keys(from.settings), ...Object.keys(to.settings)]) as Set<
    keyof TimelineSettings
  >) {
    if (from.settings[k] !== to.settings[k]) {
      ;(settings as Record<string, unknown>)[k] = to.settings[k]
      any = true
    }
  }
  return { type: 'patch', upsert, remove, ...(any ? { settings } : {}) }
}

const empty = (): Persisted => ({
  versions: [],
  cursor: 0,
  archived: [],
  edits: {},
  messages: [],
  counter: 0,
})

export const useEditor = create<EditorState>()((set, get) => ({
  ...empty(),
  projectId: null,
  preview: null,
  selection: [],
  compare: false,
  query: '',
  ask: null,
  landed: NO_LANDING,
  thinking: false,
  muted: true,
  saveState: 'idle',
  older: [],

  open: (projectId, initial, opening) => {
    const saved = sessions.get(projectId)
    set({
      ...(saved ?? { ...empty(), versions: [makeRoot(initial)], messages: opening }),
      projectId,
      preview: null,
      selection: [],
      landed: NO_LANDING,
      thinking: false,
    })
  },

  commit: (op, meta) => {
    const s = get()
    const base = s.versions[s.cursor]!.after
    let applied
    try {
      // Against the server the clips an edit creates get the ids the server will give them, so the two agree.
      applied = applyOp(
        base,
        op,
        syncer ? { newId: sequentialIds(`i_v${s.counter + 1}_`) } : undefined,
      )
    } catch (e) {
      return {
        ok: false,
        error: e instanceof OpError || e instanceof Error ? e.message : 'That change is not valid.',
      }
    }
    const counter = s.counter + 1
    const version: Version = {
      id: `v_${counter}`,
      n: counter,
      author: meta.author,
      label: meta.label,
      at: Date.now(),
      op,
      inverse: applied.inverse,
      after: applied.timeline,
      editId: meta.editId,
      undoesEditId: meta.undoesEditId,
    }
    // Editing from an earlier point keeps the later versions, in the archive, so nothing is lost.
    const keep = s.versions.slice(0, s.cursor + 1)
    const archived =
      s.cursor < s.versions.length - 1
        ? [...s.archived, ...s.versions.slice(s.cursor + 1)]
        : s.archived
    const diff = changedItemIds(base, applied.timeline)
    const added = diff.added
    const changed: string[] = []
    const moved: string[] = []
    for (const id of diff.changed) {
      const a = base.items[id]!
      const b = applied.timeline.items[id]!
      if (
        a.duration === b.duration &&
        a.srcIn === b.srcIn &&
        a.trackId === b.trackId &&
        a.label === b.label &&
        a.meta === b.meta
      )
        moved.push(id)
      else changed.push(id)
    }
    const cuts = [
      ...cutSources(op).map((src) => timeAtSource(applied.timeline, src)),
      ...rippleTimes(op),
    ].filter((t): t is number => t !== undefined)
    set({
      versions: [...keep, version],
      cursor: keep.length,
      archived,
      counter,
      preview: null,
      landed: { key: counter, added, changed, moved, cuts: cuts.slice(0, MAX_CUTS) },
    })
    syncer?.commit(version, base)
    return { ok: true, version }
  },

  undo: () => {
    const s = get()
    if (s.cursor > 0) {
      set({ cursor: s.cursor - 1, preview: null, landed: NO_LANDING })
      syncer?.undo()
    }
  },
  redo: () => {
    const s = get()
    if (s.cursor < s.versions.length - 1) {
      set({ cursor: s.cursor + 1, preview: null, landed: NO_LANDING })
      syncer?.redo()
    }
  },

  restore: (versionId) => {
    const s = get()
    const target = [...s.versions, ...s.archived].find((v) => v.id === versionId)
    if (!target) return { ok: false, error: 'That version no longer exists.' }
    const op = patchBetween(s.versions[s.cursor]!.after, target.after)
    if (!op.upsert.length && !op.remove.length && !op.settings)
      return { ok: false, error: 'This is already how the edit looks.' }
    return get().commit(op, { author: 'you', label: `Restored: ${target.label}` })
  },

  peekVersion: (versionId) => {
    if (!versionId) return set({ preview: null })
    const s = get()
    const v = [...s.versions, ...s.archived].find((x) => x.id === versionId)
    set({ preview: v ? { kind: 'version', id: v.id, timeline: v.after } : null })
  },

  registerEdit: (plan) =>
    set((s) => ({ edits: { ...s.edits, [plan.id]: s.edits[plan.id] ?? { plan } } })),

  previewEdit: (editId) => {
    if (!editId) {
      set({ preview: null })
      return null
    }
    const s = get()
    const rec = s.edits[editId]
    if (!rec) return null
    try {
      const timeline = applyOp(s.versions[s.cursor]!.after, rec.plan.op).timeline
      set({ preview: { kind: 'edit', id: editId, timeline } })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'This edit cannot be previewed.'
    }
  },

  applyEdit: (editId) => {
    const rec = get().edits[editId]
    if (!rec) return { ok: false, error: 'That edit is gone.' }
    const res = get().commit(rec.plan.op, { author: 'ai', label: rec.plan.title, editId })
    if (res.ok)
      set((s) => ({
        edits: { ...s.edits, [editId]: { plan: rec.plan, versionId: res.version.id } },
      }))
    return res
  },

  undoEdit: (editId) => {
    const s = get()
    const rec = s.edits[editId]
    const idx = rec?.versionId ? s.versions.findIndex((v) => v.id === rec.versionId) : -1
    if (!rec || idx < 0) return { ok: false, conflict: false, error: 'Nothing to undo.' }
    if (idx === s.cursor) {
      get().undo()
      return { ok: true }
    }
    const version = s.versions[idx]!
    const head = s.versions[s.cursor]!.after
    if (
      version.inverse.type === 'patch' &&
      inverseConflicts(head, version.after, version.inverse)
    ) {
      return {
        ok: false,
        conflict: true,
        error: 'Later edits changed the same parts. Restore an older version from History instead.',
      }
    }
    const res = get().commit(version.inverse, {
      author: 'you',
      label: `Undid: ${rec.plan.title}`,
      undoesEditId: editId,
    })
    if (!res.ok) return { ok: false, conflict: false, error: res.error }
    set((st) => ({ edits: { ...st.edits, [editId]: { ...rec, undoneVersionId: res.version.id } } }))
    return { ok: true }
  },

  setSelection: (ids) => set({ selection: ids }),
  setCompare: (compare) => set({ compare }),
  setQuery: (query) => set({ query }),
  askChat: (a) => set({ ask: { ...a, id: Date.now() + Math.random() } }),
  clearAsk: () => set({ ask: null }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  patchMessage: (id, patch) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  setThinking: (thinking) => set({ thinking }),
  setMuted: (muted) => set({ muted }),
  reset: () =>
    set({
      ...empty(),
      projectId: null,
      preview: null,
      selection: [],
      query: '',
      ask: null,
      landed: NO_LANDING,
      saveState: 'idle',
      older: [],
    }),

  load: (projectId, data, opening) => {
    const s = get()
    const kept = s.projectId === projectId ? s : sessions.get(projectId)
    set({
      versions: data.versions,
      cursor: data.cursor,
      archived: [],
      edits: kept?.edits ?? {},
      messages: kept?.messages ?? opening,
      counter: data.counter,
      older: data.older,
      projectId,
      preview: null,
      selection: [],
      landed: NO_LANDING,
      thinking: false,
      saveState: 'idle',
    })
  },

  adoptVersion: (id, patch) =>
    set((s) => {
      const upd = (v: Version) => (v.id === id ? { ...v, ...patch } : v)
      return { versions: s.versions.map(upd), archived: s.archived.map(upd) }
    }),

  pushRemote: (version) =>
    set((s) => {
      const keep = s.versions.slice(0, s.cursor + 1)
      const archived =
        s.cursor < s.versions.length - 1
          ? [...s.archived, ...s.versions.slice(s.cursor + 1)]
          : s.archived
      return {
        versions: [...keep, version],
        cursor: keep.length,
        archived,
        counter: Math.max(s.counter, version.n),
        preview: null,
        landed: NO_LANDING,
      }
    }),

  setSaveState: (saveState) => set({ saveState }),
  setOlder: (older) => set({ older }),
}))

// Keep each project's session in memory, so leaving the editor and coming back loses nothing.
useEditor.subscribe((s) => {
  if (!s.projectId || !s.versions.length) return
  sessions.set(s.projectId, {
    versions: s.versions,
    cursor: s.cursor,
    archived: s.archived,
    edits: s.edits,
    messages: s.messages,
    counter: s.counter,
  })
})

export function clearSession(projectId: string) {
  sessions.delete(projectId)
}

// Nothing of one person's edit survives them signing out.
onSignOut(() => {
  sessions.clear()
  useEditor.getState().reset()
})

/* ---------------- selectors ---------------- */

type S = EditorState
export const headTimeline = (s: S): Timeline => s.versions[s.cursor]!.after
/** What the player and timeline show: a preview if one is open, else the current edit. */
export const shownTimeline = (s: S): Timeline => s.preview?.timeline ?? s.versions[s.cursor]!.after
export const canUndo = (s: S) => s.cursor > 0
export const canRedo = (s: S) => s.cursor < s.versions.length - 1

export function editStatus(s: S, editId: string): EditStatus {
  if (s.preview?.kind === 'edit' && s.preview.id === editId) return 'previewing'
  const rec = s.edits[editId]
  if (!rec?.versionId) return 'proposed'
  const at = s.versions.findIndex((v) => v.id === rec.versionId)
  if (at < 0 || at > s.cursor) return 'undone'
  if (rec.undoneVersionId) {
    const u = s.versions.findIndex((v) => v.id === rec.undoneVersionId)
    if (u >= 0 && u <= s.cursor) return 'undone'
  }
  return 'applied'
}
