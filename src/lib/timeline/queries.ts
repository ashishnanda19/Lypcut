import type { Timeline, TimelineItem, Track, TrackKind, Word } from '@/types'

/**
 * Read-only helpers over a Timeline. Results are cached against the identity of
 * `timeline.items`, which changes on every edit, so repeated calls during one render
 * pass (and 60fps playback) cost nothing.
 */

const byTrackCache = new WeakMap<object, Record<string, TimelineItem[]>>()
const coverageCache = new WeakMap<object, Array<[number, number]>>()
const flagsCache = new WeakMap<object, WeakMap<object, Uint8Array>>()

export function itemsByTrack(tl: Timeline): Record<string, TimelineItem[]> {
  const hit = byTrackCache.get(tl.items)
  if (hit) return hit
  const out: Record<string, TimelineItem[]> = {}
  for (const t of tl.tracks) out[t.id] = []
  for (const it of Object.values(tl.items)) (out[it.trackId] ??= []).push(it)
  for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start)
  byTrackCache.set(tl.items, out)
  return out
}

export function trackByKind(tl: Timeline, kind: TrackKind): Track | undefined {
  return tl.tracks.find((t) => t.kind === kind)
}

export const itemEnd = (it: TimelineItem) => it.start + it.duration

export function trackItems(tl: Timeline, trackId: string): TimelineItem[] {
  return itemsByTrack(tl)[trackId] ?? []
}

/** Items of a given kind, sorted by start. */
export function itemsOfKind(tl: Timeline, kind: TimelineItem['kind']): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const it of Object.values(tl.items)) if (it.kind === kind) out.push(it)
  return out.sort((a, b) => a.start - b.start)
}

/** Length of the edited result: the end of the last video or audio clip. */
export function timelineDuration(tl: Timeline): number {
  let end = 0
  for (const it of Object.values(tl.items)) {
    if (it.kind === 'video' || it.kind === 'audio') end = Math.max(end, itemEnd(it))
  }
  return end
}

/** Binary search: the item whose [start, end) contains t, in a list sorted by start. */
export function findAt(sorted: TimelineItem[], t: number): TimelineItem | undefined {
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const it = sorted[mid]!
    if (t < it.start) hi = mid - 1
    else if (t >= itemEnd(it)) lo = mid + 1
    else return it
  }
  return undefined
}

export function videoItems(tl: Timeline): TimelineItem[] {
  const track = trackByKind(tl, 'video')
  return track ? trackItems(tl, track.id) : []
}

/** Source time at a timeline time, or undefined when the playhead sits in a gap. */
export function srcTimeAt(tl: Timeline, t: number): number | undefined {
  const it = findAt(videoItems(tl), t)
  return it ? it.srcIn + (t - it.start) : undefined
}

/** Timeline time of a source time, or undefined when that part of the source has been cut. */
export function timeAtSource(tl: Timeline, srcT: number): number | undefined {
  for (const it of videoItems(tl)) {
    if (srcT >= it.srcIn - 1e-6 && srcT < it.srcIn + it.duration)
      return it.start + (srcT - it.srcIn)
  }
  return undefined
}

/** Merged source intervals that still appear in the edit. */
export function coverage(tl: Timeline): Array<[number, number]> {
  const hit = coverageCache.get(tl.items)
  if (hit) return hit
  const spans = videoItems(tl)
    .map((it): [number, number] => [it.srcIn, it.srcIn + it.duration])
    .sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s[0] <= last[1] + 0.02) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  coverageCache.set(tl.items, merged)
  return merged
}

/** Parts of [from, to] (source time) that are covered / not covered by the current edit. */
export function splitByCoverage(
  tl: Timeline,
  from: number,
  to: number,
): { covered: Array<[number, number]>; cut: Array<[number, number]> } {
  const covered: Array<[number, number]> = []
  const cut: Array<[number, number]> = []
  let cursor = from
  for (const [a, b] of coverage(tl)) {
    if (b <= cursor) continue
    if (a >= to) break
    if (a > cursor) cut.push([cursor, Math.min(a, to)])
    const ca = Math.max(a, cursor)
    const cb = Math.min(b, to)
    if (cb > ca) covered.push([ca, cb])
    cursor = Math.max(cursor, b)
    if (cursor >= to) break
  }
  if (cursor < to) cut.push([cursor, to])
  return { covered, cut: cut.filter(([a, b]) => b - a > 1e-3) }
}

/**
 * 1 for every transcript word that has been cut from the edit.
 * A word counts as cut when its midpoint is no longer covered by any video clip.
 */
export function cutFlags(tl: Timeline, words: Word[]): Uint8Array {
  let perWords = flagsCache.get(tl.items)
  if (!perWords) {
    perWords = new WeakMap()
    flagsCache.set(tl.items, perWords)
  }
  const hit = perWords.get(words)
  if (hit) return hit
  const cov = coverage(tl)
  const flags = new Uint8Array(words.length)
  let ci = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const mid = (w.start + w.end) / 2
    while (ci < cov.length && cov[ci]![1] <= mid) ci++
    const c = cov[ci]
    flags[i] = c && mid >= c[0] ? 0 : 1
  }
  perWords.set(words, flags)
  return flags
}

export function captionItems(tl: Timeline): TimelineItem[] {
  const track = trackByKind(tl, 'captions')
  return track ? trackItems(tl, track.id) : []
}

export function captionAt(tl: Timeline, t: number): TimelineItem | undefined {
  return findAt(captionItems(tl), t)
}

/** Index of the word playing at a source time (binary search), or -1. */
export function wordIndexAt(words: Word[], srcT: number): number {
  let lo = 0
  let hi = words.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = words[mid]!
    if (w.start <= srcT) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (best >= 0 && srcT > words[best]!.end + 0.6) return -1
  return best
}

/** Items that differ between two timelines, for the History compare view. */
export function diffTimelines(
  a: Timeline,
  b: Timeline,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const id of Object.keys(b.items)) {
    const x = a.items[id]
    const y = b.items[id]!
    if (!x) added.push(id)
    else if (
      x !== y &&
      (x.start !== y.start ||
        x.duration !== y.duration ||
        x.srcIn !== y.srcIn ||
        x.trackId !== y.trackId)
    )
      changed.push(id)
  }
  for (const id of Object.keys(a.items)) if (!b.items[id]) removed.push(id)
  return { added, removed, changed }
}
