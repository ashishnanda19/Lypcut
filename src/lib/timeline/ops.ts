import type {
  ItemKind,
  Timeline,
  TimelineItem,
  TimelineOp,
  TimelineSettings,
  TrackKind,
} from '@/types'
import { uid } from '@/lib/ids'
import { itemEnd, splitByCoverage, timelineDuration, trackByKind, videoItems } from './queries'

/**
 * The timeline engine. Pure functions, no React.
 *
 *   applyOp(timeline, op) -> { timeline, inverse }
 *
 * `inverse` is always a low-level `patch` op that restores exactly what the op touched,
 * so any applied op can be undone, and undoing is itself an op that can be undone again.
 * Invalid ops throw OpError and change nothing: the assistant proposes ops, this file
 * is the gatekeeper.
 */

export const MIN_DUR = 0.1
const EPS = 1e-4

export class OpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpError'
  }
}

/** Which track kinds each kind of clip may live on. */
const COMPATIBLE: Record<ItemKind, TrackKind[]> = {
  video: ['video', 'broll'],
  broll: ['broll', 'video'],
  audio: ['audio'],
  caption: ['captions'],
  effect: ['effects'],
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const near = (a: number, b: number) => Math.abs(a - b) < 0.02

/* ------------------------------------------------------------------ */
/* Draft: a mutable scratch copy that records what it touched           */
/* ------------------------------------------------------------------ */

class Draft {
  items: Record<string, TimelineItem>
  touched = new Set<string>()
  keys = new Set<keyof TimelineSettings>()
  settings: TimelineSettings
  base: Timeline

  constructor(base: Timeline) {
    this.base = base
    this.items = { ...base.items }
    this.settings = base.settings
  }

  /**
   * A snapshot. It must be a fresh object every time: query caches are keyed on the identity of
   * `items`, so handing out the live (mutating) object would let them serve stale answers.
   */
  get timeline(): Timeline {
    return { ...this.base, items: { ...this.items }, settings: this.settings }
  }

  get(id: string): TimelineItem {
    const it = this.items[id]
    if (!it) throw new OpError(`Clip ${id} was not found.`)
    return it
  }

  set(it: TimelineItem) {
    this.items[it.id] = it
    this.touched.add(it.id)
  }

  remove(id: string) {
    if (this.items[id]) {
      delete this.items[id]
      this.touched.add(id)
    }
  }

  patchSettings(patch: Partial<TimelineSettings>) {
    for (const k of Object.keys(patch) as Array<keyof TimelineSettings>) this.keys.add(k)
    this.settings = { ...this.settings, ...patch }
  }
}

function trackOf(tl: Timeline, trackId: string) {
  const t = tl.tracks.find((x) => x.id === trackId)
  if (!t) throw new OpError(`Track ${trackId} does not exist.`)
  return t
}

function assertUnlocked(tl: Timeline, trackId: string) {
  if (trackOf(tl, trackId).locked) throw new OpError('That track is locked.')
}

function assertFinite(...nums: number[]) {
  for (const n of nums) if (!Number.isFinite(n)) throw new OpError('Times must be numbers.')
}

function assertNoOverlap(d: Draft, next: TimelineItem) {
  for (const o of Object.values(d.items)) {
    if (o.id === next.id || o.trackId !== next.trackId) continue
    if (next.start < itemEnd(o) - 1e-3 && itemEnd(next) > o.start + 1e-3) {
      throw new OpError("Clips can't overlap on the same track.")
    }
  }
}

/* ------------------------------------------------------------------ */
/* Leaf operations                                                      */
/* ------------------------------------------------------------------ */

function doTrim(d: Draft, op: Extract<TimelineOp, { type: 'trim' }>) {
  const it = d.get(op.itemId)
  assertUnlocked(d.base, it.trackId)
  assertFinite(op.to)
  const bound = it.kind === 'video' || it.kind === 'audio'
  let next: TimelineItem
  if (op.edge === 'start') {
    const lo = bound ? Math.max(0, it.start - it.srcIn) : 0
    const to = clamp(op.to, lo, itemEnd(it) - MIN_DUR)
    const delta = to - it.start
    next = { ...it, start: to, duration: it.duration - delta, srcIn: it.srcIn + delta }
  } else {
    const hi = bound ? it.start + (d.base.sourceDuration - it.srcIn) : Infinity
    const to = clamp(op.to, it.start + MIN_DUR, hi)
    next = { ...it, duration: to - it.start }
  }
  assertNoOverlap(d, next)
  d.set(next)
}

function doSplit(d: Draft, op: Extract<TimelineOp, { type: 'split' }>) {
  const it = d.get(op.itemId)
  assertUnlocked(d.base, it.trackId)
  assertFinite(op.at)
  if (op.at < it.start + MIN_DUR || op.at > itemEnd(it) - MIN_DUR) {
    throw new OpError('Move the playhead inside the clip to split it.')
  }
  const first: TimelineItem = { ...it, duration: op.at - it.start }
  const second: TimelineItem = {
    ...it,
    id: op.newId ?? uid('i'),
    start: op.at,
    duration: itemEnd(it) - op.at,
    srcIn: it.srcIn + (op.at - it.start),
  }
  d.set(first)
  d.set(second)
}

function doMove(d: Draft, op: Extract<TimelineOp, { type: 'move' }>) {
  const it = d.get(op.itemId)
  const trackId = op.trackId ?? it.trackId
  assertFinite(op.start)
  if (op.start < 0) throw new OpError("Clips can't start before zero.")
  assertUnlocked(d.base, it.trackId)
  assertUnlocked(d.base, trackId)
  if (!COMPATIBLE[it.kind].includes(trackOf(d.base, trackId).kind)) {
    throw new OpError("That clip doesn't belong on this track.")
  }
  const next = { ...it, trackId, start: op.start }
  assertNoOverlap(d, next)
  d.set(next)
}

function doDelete(d: Draft, ids: string[]) {
  for (const id of ids) {
    const it = d.get(id)
    assertUnlocked(d.base, it.trackId)
    d.remove(id)
  }
}

function doRipple(d: Draft, op: Extract<TimelineOp, { type: 'rippleDelete' }>) {
  const { from, to } = op
  assertFinite(from, to)
  if (from < 0 || to <= from) throw new OpError('Pick a range to remove.')
  const len = to - from
  const allowed = new Set(
    (op.trackIds ?? d.base.tracks.map((t) => t.id)).filter(
      (id) => !d.base.tracks.find((t) => t.id === id)?.locked,
    ),
  )
  for (const it of Object.values(d.items)) {
    if (!allowed.has(it.trackId)) continue
    const s = it.start
    const e = itemEnd(it)
    if (e <= from + EPS) continue
    if (s >= to - EPS) {
      d.set({ ...it, start: s - len })
    } else if (s >= from - EPS && e <= to + EPS) {
      d.remove(it.id)
    } else if (s < from - EPS && e > to + EPS) {
      d.set({ ...it, duration: from - s })
      d.set({ ...it, id: uid('i'), start: from, duration: e - to, srcIn: it.srcIn + (to - s) })
    } else if (s < from - EPS) {
      d.set({ ...it, duration: from - s })
    } else {
      d.set({ ...it, start: from, duration: e - to, srcIn: it.srcIn + (to - s) })
    }
  }
}

function doCutSource(d: Draft, op: Extract<TimelineOp, { type: 'cutSource' }>) {
  assertFinite(op.srcFrom, op.srcTo)
  if (op.srcTo <= op.srcFrom) throw new OpError('Pick a range to cut.')
  const tl = d.timeline
  const { covered } = splitByCoverage(tl, op.srcFrom, op.srcTo)
  const ranges: Array<[number, number]> = []
  for (const [a, b] of covered) {
    for (const v of videoItems(tl)) {
      const lo = Math.max(a, v.srcIn)
      const hi = Math.min(b, v.srcIn + v.duration)
      if (hi - lo > 0.01) ranges.push([v.start + (lo - v.srcIn), v.start + (hi - v.srcIn)])
    }
  }
  // Latest range first: removing it never shifts the ones before it.
  ranges.sort((x, y) => y[0] - x[0])
  for (const [from, to] of ranges) doRipple(d, { type: 'rippleDelete', from, to })
}

function doRestoreSource(d: Draft, op: Extract<TimelineOp, { type: 'restoreSource' }>) {
  assertFinite(op.srcFrom, op.srcTo)
  if (op.srcTo <= op.srcFrom || op.srcFrom < 0 || op.srcTo > d.base.sourceDuration + EPS) {
    throw new OpError('That part of the video does not exist.')
  }
  const { cut } = splitByCoverage(d.timeline, op.srcFrom, op.srcTo)
  // Earliest piece first so each insertion point is computed against the latest state.
  for (const [a, b] of cut.sort((x, y) => x[0] - y[0])) insertSource(d, a, b, op.captions)
}

function insertSource(d: Draft, a: number, b: number, captions?: TimelineItem[]) {
  const tl = d.timeline
  const len = b - a
  let at = 0
  for (const v of videoItems(tl)) {
    if (v.srcIn + v.duration <= a + 0.02) at = Math.max(at, itemEnd(v))
  }

  // Make room: everything at or after `at` moves right, anything straddling it splits.
  for (const it of Object.values(d.items)) {
    if (d.base.tracks.find((t) => t.id === it.trackId)?.locked) continue
    const e = itemEnd(it)
    if (it.start >= at - EPS) d.set({ ...it, start: it.start + len })
    else if (e > at + EPS) {
      d.set({ ...it, duration: at - it.start })
      d.set({
        ...it,
        id: uid('i'),
        start: at + len,
        duration: e - at,
        srcIn: it.srcIn + (at - it.start),
      })
    }
  }

  const place = (kind: 'video' | 'audio', label: string) => {
    const track = trackByKind(d.timeline, kind)
    if (!track) return
    const siblings = Object.values(d.items).filter((x) => x.trackId === track.id && x.kind === kind)
    const prev = siblings.find((x) => near(itemEnd(x), at) && near(x.srcIn + x.duration, a))
    const next = siblings.find((x) => near(x.start, at + len) && near(x.srcIn, b))
    if (prev && next) {
      d.set({ ...prev, duration: prev.duration + len + next.duration })
      d.remove(next.id)
    } else if (prev) {
      d.set({ ...prev, duration: prev.duration + len })
    } else if (next) {
      d.set({ ...next, start: at, srcIn: a, duration: next.duration + len })
    } else {
      d.set({ id: uid('i'), trackId: track.id, kind, label, start: at, duration: len, srcIn: a })
    }
  }
  place('video', 'Restored')
  place('audio', 'Voice')

  const capTrack = trackByKind(d.timeline, 'captions')
  if (capTrack && captions) {
    for (const c of captions) {
      if (c.srcIn < a - 0.01 || c.srcIn >= b) continue
      d.set({
        ...c,
        id: uid('i'),
        trackId: capTrack.id,
        start: at + (c.srcIn - a),
        duration: Math.min(c.duration, b - c.srcIn),
      })
    }
  }
}

function doAddCaptions(d: Draft, op: Extract<TimelineOp, { type: 'addCaptions' }>) {
  const track = trackByKind(d.base, 'captions')
  if (!track) throw new OpError('This project has no captions track.')
  assertUnlocked(d.base, track.id)
  if (op.replace) {
    for (const it of Object.values(d.items)) if (it.trackId === track.id) d.remove(it.id)
  }
  for (const c of op.items) {
    if (c.kind !== 'caption') throw new OpError('Only captions can go on the captions track.')
    d.set({ ...c, trackId: track.id })
  }
  d.patchSettings({ captionsOn: true })
}

function doAddEffect(d: Draft, op: Extract<TimelineOp, { type: 'addEffect' }>) {
  const track = trackByKind(d.base, 'effects')
  if (!track) throw new OpError('This project has no effects track.')
  if (op.item.kind !== 'effect') throw new OpError('Only effects can go on the effects track.')
  const next = { ...op.item, trackId: track.id }
  assertNoOverlap(d, next)
  d.set(next)
}

function doSetCrop(d: Draft, op: Extract<TimelineOp, { type: 'setCrop' }>) {
  const { x, y, scale } = op.crop
  assertFinite(x, y, scale)
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new OpError('The crop must stay inside the frame.')
  if (scale < 1 || scale > 4) throw new OpError('Zoom must be between 1x and 4x.')
  d.patchSettings(op.keyframes ? { crop: op.crop, keyframes: op.keyframes } : { crop: op.crop })
}

function run(d: Draft, op: TimelineOp): void {
  switch (op.type) {
    case 'trim':
      return doTrim(d, op)
    case 'split':
      return doSplit(d, op)
    case 'move':
      return doMove(d, op)
    case 'delete':
      return doDelete(d, op.itemIds)
    case 'rippleDelete':
      return doRipple(d, op)
    case 'cutSource':
      return doCutSource(d, op)
    case 'restoreSource':
      return doRestoreSource(d, op)
    case 'addCaptions':
      return doAddCaptions(d, op)
    case 'addEffect':
      return doAddEffect(d, op)
    case 'setCrop':
      return doSetCrop(d, op)
    case 'setCaptionStyle':
      return d.patchSettings({ captionStyleId: op.styleId, captionsOn: true })
    case 'setSettings':
      return d.patchSettings(op.patch)
    case 'addMarker':
      return d.patchSettings({ markers: [...d.settings.markers, op.marker] })
    case 'removeMarker':
      return d.patchSettings({ markers: d.settings.markers.filter((m) => m.id !== op.id) })
    case 'patch': {
      for (const id of op.remove) d.remove(id)
      for (const it of op.upsert) d.set(it)
      if (op.settings) d.patchSettings(op.settings)
      return
    }
    case 'batch':
      for (const o of op.ops) run(d, o)
      return
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

export interface Applied {
  timeline: Timeline
  inverse: Extract<TimelineOp, { type: 'patch' }>
}

/** Apply an op. Throws OpError (and changes nothing) if it is not valid for this timeline. */
export function applyOp(tl: Timeline, op: TimelineOp): Applied {
  const d = new Draft(tl)
  run(d, op)
  const after = d.timeline

  const upsert: TimelineItem[] = []
  const remove: string[] = []
  for (const id of d.touched) {
    const before = tl.items[id]
    if (before) {
      if (after.items[id] !== before) upsert.push(before)
    } else if (after.items[id]) {
      remove.push(id)
    }
  }
  let settings: Partial<TimelineSettings> | undefined
  if (d.keys.size) {
    const rec: Record<string, unknown> = {}
    for (const k of d.keys) rec[k] = tl.settings[k]
    settings = rec as Partial<TimelineSettings>
  }
  return {
    timeline: after,
    inverse: { type: 'patch', upsert, remove, ...(settings ? { settings } : {}) },
  }
}

/** Dry-run an op and return human-readable problems. Empty means the op is valid. */
export function validateOp(tl: Timeline, op: TimelineOp): string[] {
  try {
    applyOp(tl, op)
    return []
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)]
  }
}

/** Items added or changed between two timelines. Used to play the "landed" animation. */
export function changedItemIds(
  before: Timeline,
  after: Timeline,
): { added: string[]; changed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  for (const [id, it] of Object.entries(after.items)) {
    const b = before.items[id]
    if (!b) added.push(id)
    else if (b !== it) changed.push(id)
  }
  return { added, changed }
}

export function describeTimeline(tl: Timeline): { duration: number; clips: number } {
  return { duration: timelineDuration(tl), clips: Object.keys(tl.items).length }
}

/**
 * Would applying `inverse` now clobber later edits? It conflicts when any item it would
 * overwrite has changed since the version was made. Used for one-click "undo this AI action".
 */
export function inverseConflicts(
  current: Timeline,
  versionAfter: Timeline,
  inverse: Extract<TimelineOp, { type: 'patch' }>,
): boolean {
  for (const it of inverse.upsert) {
    if (versionAfter.items[it.id] !== current.items[it.id]) return true
  }
  for (const id of inverse.remove) {
    if (versionAfter.items[id] !== current.items[id]) return true
  }
  if (inverse.settings) {
    for (const k of Object.keys(inverse.settings) as Array<keyof TimelineSettings>) {
      if (versionAfter.settings[k] !== current.settings[k]) return true
    }
  }
  return false
}
