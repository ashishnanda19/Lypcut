import { buildInitialTimeline } from '@lypcut/timeline-core'
import { applyOp } from '@lypcut/timeline-core'
import type { Timeline, TimelineItem, TimelineOp } from '@lypcut/timeline-core'

/** A small seeded random number generator, so a failing fuzz run can be replayed exactly. */
export function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Sample {
  timeline: Timeline
  /** Transcript words in source time, 0.5 s each, for the cut-flag queries. */
  words: Array<{ start: number; end: number }>
  duration: number
}

/**
 * A 280 second source in 8 scenes of 35 s, with a clip of video and voice per scene (as the pipeline builds it)
 * plus four B-roll clips, so every kind of edit has something to work on.
 */
export function sampleTimeline(scenes = 8, sceneSec = 35): Sample {
  const duration = scenes * sceneSec
  const base = buildInitialTimeline(
    Array.from({ length: scenes }, (_, i) => ({
      id: `s${i}`,
      label: `Scene ${i + 1}`,
      start: i * sceneSec,
      end: (i + 1) * sceneSec,
    })),
    duration,
  )
  const items: Record<string, TimelineItem> = { ...base.items }
  ;[0.18, 0.4, 0.62, 0.82].forEach((p, i) => {
    items[`b_${i}`] = {
      id: `b_${i}`,
      trackId: 'trk_broll',
      kind: 'broll',
      label: `B-roll ${i + 1}`,
      start: Math.round(duration * p),
      duration: 6 + (i % 2) * 2,
      srcIn: 0,
    }
  })
  const words = Array.from({ length: duration * 2 }, (_, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  }))
  return { timeline: { ...base, items }, words, duration }
}

/** Captions covering [from, to) in source time, one per second, as the assistant's "add captions" produces. */
export function captionItems(from: number, to: number, prefix = 'c'): TimelineItem[] {
  const out: TimelineItem[] = []
  for (let t = from; t < to; t += 1) {
    out.push({
      id: `${prefix}${t}`,
      trackId: 'trk_captions',
      kind: 'caption',
      label: `Caption ${t}`,
      start: t,
      duration: 0.9,
      srcIn: t,
      meta: { text: `word ${t}`, dev: `शब्द ${t}`, wordFrom: t * 2, wordTo: t * 2 + 2 },
    })
  }
  return out
}

export const sorted = (tl: Timeline): TimelineItem[] =>
  Object.values(tl.items).sort((a, b) => a.id.localeCompare(b.id))

/** Recursively freezes a value, so any attempt to change it throws (the tests run in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Applies several ops in order, returning the final timeline. */
export function applyAll(tl: Timeline, ops: TimelineOp[], newId?: () => string): Timeline {
  return ops.reduce((acc, op) => applyOp(acc, op, { newId }).timeline, tl)
}
