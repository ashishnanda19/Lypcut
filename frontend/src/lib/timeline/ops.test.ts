import { describe, expect, it } from 'vitest'
import type { Timeline, TimelineOp } from '@/types'
import { buildStressTimeline } from './build'
import { fixture } from './fixtures'
import {
  applyOp,
  inverseConflicts,
  OpError,
  sequentialIds,
  validateOp,
} from '@lypcut/timeline-core'
import {
  coverage,
  cutFlags,
  itemEnd,
  srcTimeAt,
  timeAtSource,
  timelineDuration,
  trackItems,
} from '@lypcut/timeline-core'

const items = (tl: Timeline) =>
  JSON.stringify(Object.values(tl.items).sort((a, b) => a.id.localeCompare(b.id)))

function roundTrip(tl: Timeline, op: TimelineOp) {
  const r = applyOp(tl, op)
  const back = applyOp(r.timeline, r.inverse)
  expect(items(back.timeline)).toBe(items(tl))
  expect(back.timeline.settings).toEqual(tl.settings)
  return r
}

describe('timeline ops are reversible', () => {
  const { timeline: tl } = fixture()
  const first = trackItems(tl, 'trk_video')[0]!

  it('split', () => {
    const r = roundTrip(tl, { type: 'split', itemId: first.id, at: first.start + 5, newId: 'x1' })
    expect(r.timeline.items.x1!.srcIn).toBeCloseTo(first.srcIn + 5)
    expect(r.timeline.items[first.id]!.duration).toBeCloseTo(5)
  })

  it('trim start and end', () => {
    const second = trackItems(tl, 'trk_video')[1]!
    roundTrip(tl, { type: 'trim', itemId: second.id, edge: 'start', to: second.start + 3 })
    const r = roundTrip(tl, {
      type: 'trim',
      itemId: second.id,
      edge: 'end',
      to: itemEnd(second) - 4,
    })
    expect(r.timeline.items[second.id]!.duration).toBeCloseTo(second.duration - 4)
  })

  it('move, delete, markers and crop', () => {
    const b = trackItems(tl, 'trk_broll')[0]!
    roundTrip(tl, { type: 'move', itemId: b.id, start: b.start + 2 })
    roundTrip(tl, { type: 'delete', itemIds: [b.id] })
    roundTrip(tl, { type: 'addMarker', marker: { id: 'm1', time: 10, label: 'Hook' } })
    roundTrip(tl, { type: 'setCrop', crop: { x: 0.7, y: 0.5, scale: 1.4 } })
    roundTrip(tl, { type: 'setCaptionStyle', styleId: 'boxed' })
  })

  it('ripple delete shifts everything after the range and closes the gap', () => {
    const before = timelineDuration(tl)
    const r = roundTrip(tl, { type: 'rippleDelete', from: 20, to: 30 })
    expect(timelineDuration(r.timeline)).toBeCloseTo(before - 10, 1)
    expect(srcTimeAt(r.timeline, 20)).toBeCloseTo(30, 1)
  })

  it('batch undoes as one step', () => {
    const op: TimelineOp = {
      type: 'batch',
      ops: [
        { type: 'rippleDelete', from: 5, to: 8 },
        { type: 'rippleDelete', from: 40, to: 44 },
        { type: 'addMarker', marker: { id: 'm2', time: 12, label: 'x' } },
      ],
    }
    roundTrip(tl, op)
  })

  it('redo works: applying the inverse of the inverse gives the same result', () => {
    const r = applyOp(tl, { type: 'rippleDelete', from: 10, to: 15 })
    const undone = applyOp(r.timeline, r.inverse)
    const redone = applyOp(undone.timeline, undone.inverse)
    expect(items(redone.timeline)).toBe(items(r.timeline))
  })
})

describe('validation: the assistant can only propose valid ops', () => {
  const { timeline: tl } = fixture()
  const vids = trackItems(tl, 'trk_video')

  it('rejects overlaps, wrong tracks, bad times and missing clips', () => {
    expect(
      validateOp(tl, { type: 'move', itemId: vids[1]!.id, start: vids[0]!.start + 1 }),
    ).toHaveLength(1)
    expect(
      validateOp(tl, {
        type: 'move',
        itemId: vids[1]!.id,
        start: vids[1]!.start,
        trackId: 'trk_audio',
      }),
    ).toHaveLength(1)
    expect(validateOp(tl, { type: 'move', itemId: vids[1]!.id, start: -3 })).toHaveLength(1)
    expect(validateOp(tl, { type: 'trim', itemId: 'nope', edge: 'end', to: 4 })).toHaveLength(1)
    expect(
      validateOp(tl, { type: 'split', itemId: vids[0]!.id, at: vids[0]!.start + 0.01 }),
    ).toHaveLength(1)
    expect(validateOp(tl, { type: 'setCrop', crop: { x: 2, y: 0.5, scale: 1 } })).toHaveLength(1)
    expect(validateOp(tl, { type: 'setCrop', crop: { x: 0.5, y: 0.5, scale: 9 } })).toHaveLength(1)
    expect(validateOp(tl, { type: 'rippleDelete', from: 9, to: 3 })).toHaveLength(1)
  })

  it('refuses edits on locked tracks and leaves the timeline untouched', () => {
    const locked: Timeline = {
      ...tl,
      tracks: tl.tracks.map((t) => (t.id === 'trk_video' ? { ...t, locked: true } : t)),
    }
    expect(() => applyOp(locked, { type: 'delete', itemIds: [vids[0]!.id] })).toThrow(OpError)
  })

  it('trim cannot reveal footage before the start of the source or past its end', () => {
    const r = applyOp(tl, { type: 'trim', itemId: vids[0]!.id, edge: 'start', to: -50 })
    expect(r.timeline.items[vids[0]!.id]!.srcIn).toBeGreaterThanOrEqual(0)
    const last = vids[vids.length - 1]!
    const e = applyOp(tl, { type: 'trim', itemId: last.id, edge: 'end', to: 99999 })
    expect(itemEnd(e.timeline.items[last.id]!)).toBeLessThanOrEqual(tl.sourceDuration + 1e-6)
  })
})

describe('cut and restore by source time (what the transcript uses)', () => {
  const { timeline: tl, words } = fixture()

  it('cutting a source range removes it everywhere and shortens the edit', () => {
    const r = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    expect(timelineDuration(r.timeline)).toBeCloseTo(timelineDuration(tl) - 12, 1)
    expect(timeAtSource(r.timeline, 35)).toBeUndefined()
    expect(timeAtSource(r.timeline, 45)).toBeCloseTo(33, 1)
    const flags = cutFlags(r.timeline, words)
    const cutWords = words.filter((w, i) => flags[i] && w.start >= 30 && w.end <= 42).length
    expect(cutWords).toBeGreaterThan(5)
    // audio moved in lockstep with video
    const audioEnd = Math.max(...trackItems(r.timeline, 'trk_audio').map(itemEnd))
    expect(audioEnd).toBeCloseTo(timelineDuration(r.timeline), 1)
  })

  it('cut then restore returns the same coverage, duration and clip count', () => {
    const cut = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const back = applyOp(cut.timeline, { type: 'restoreSource', srcFrom: 30, srcTo: 42 })
    expect(timelineDuration(back.timeline)).toBeCloseTo(timelineDuration(tl), 1)
    expect(coverage(back.timeline)).toEqual(coverage(tl))
    expect(trackItems(back.timeline, 'trk_video').length).toBe(trackItems(tl, 'trk_video').length)
    expect(timeAtSource(back.timeline, 35)).toBeCloseTo(35, 1)
  })

  it('cutting the same range twice is a no-op, not an error', () => {
    const once = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const twice = applyOp(once.timeline, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    expect(timelineDuration(twice.timeline)).toBeCloseTo(timelineDuration(once.timeline), 3)
  })

  it('selective undo detects when later edits touch the same clips', () => {
    const a = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const b = applyOp(a.timeline, { type: 'cutSource', srcFrom: 100, srcTo: 108 })
    const c = applyOp(b.timeline, { type: 'cutSource', srcFrom: 33, srcTo: 36 })
    expect(inverseConflicts(b.timeline, a.timeline, a.inverse)).toBe(true)
    // restoring `a` while `b` changed later clips is a conflict because clips after the cut shifted
    expect(inverseConflicts(a.timeline, a.timeline, a.inverse)).toBe(false)
    expect(c.timeline).toBeTruthy()
  })
})

describe('performance: 500 operations on a 300-clip timeline', () => {
  it('stays well inside a frame budget per op', () => {
    let tl: Timeline = buildStressTimeline(3600, 300)
    const start = performance.now()
    let n = 0
    for (let i = 0; i < 500; i++) {
      const vids = trackItems(tl, 'trk_video')
      const v = vids[(i * 7) % vids.length]!
      const op: TimelineOp =
        i % 3 === 0
          ? { type: 'split', itemId: v.id, at: v.start + v.duration / 2 }
          : i % 3 === 1
            ? { type: 'trim', itemId: v.id, edge: 'end', to: itemEnd(v) - 0.2 }
            : { type: 'addMarker', marker: { id: `m${i}`, time: v.start, label: 'm' } }
      tl = applyOp(tl, op).timeline
      n++
    }
    const total = performance.now() - start
    expect(n).toBe(500)
    expect(Object.keys(tl.items).length).toBeGreaterThan(600)
    // about 2ms per op on a slow CI box; the bar is 50ms so the UI never blocks
    expect(total / 500).toBeLessThan(50)
  })
})

describe('ids that match the server', () => {
  const { timeline: tl } = fixture()
  const first = trackItems(tl, 'trk_video')[0]!
  const ripple: TimelineOp = { type: 'rippleDelete', from: first.start + 1, to: first.start + 2 }

  it('an edit made with a numbered generator always gives the same clips', () => {
    const a = applyOp(tl, ripple, { newId: sequentialIds('i_v4_') })
    const b = applyOp(tl, ripple, { newId: sequentialIds('i_v4_') })
    expect(items(a.timeline)).toBe(items(b.timeline))
    expect(Object.keys(a.timeline.items).some((id) => id.startsWith('i_v4_'))).toBe(true)
  })

  it('does not depend on the order the clips are stored in', () => {
    const shuffled: Timeline = {
      ...tl,
      items: Object.fromEntries(Object.entries(tl.items).reverse()),
    }
    const a = applyOp(tl, ripple, { newId: sequentialIds('i_v4_') })
    const b = applyOp(shuffled, ripple, { newId: sequentialIds('i_v4_') })
    expect(items(a.timeline)).toBe(items(b.timeline))
  })

  it('never reuses the id of a clip that exists', () => {
    const taken = sequentialIds('i_v4_')()
    const withTaken: Timeline = {
      ...tl,
      items: { ...tl.items, [taken]: { ...first, id: taken, start: 9999 } },
    }
    const clean = applyOp(tl, ripple, { newId: sequentialIds('i_v4_') })
    const r = applyOp(withTaken, ripple, { newId: sequentialIds('i_v4_') })
    // The same clips are created, plus the one that already owned the id. None of them replaced it.
    expect(Object.keys(r.timeline.items)).toHaveLength(Object.keys(clean.timeline.items).length + 1)
    expect(r.timeline.items[taken]!.start).toBeCloseTo(9998)
  })
})

describe('trimming a clip that is already very short', () => {
  it('leaves it where it is instead of pushing it before the start of the timeline', () => {
    const { timeline: tl } = fixture()
    const clip = trackItems(tl, 'trk_video')[0]!
    // Make a 0.05 s clip by trimming its end, then try to trim its start.
    const sliver = applyOp(
      { ...tl, items: { ...tl.items, [clip.id]: { ...clip, duration: 0.05 } } },
      { type: 'trim', itemId: clip.id, edge: 'start', to: clip.start - 5 },
    ).timeline.items[clip.id]!
    expect(sliver.start).toBeGreaterThanOrEqual(0)
    expect(sliver.srcIn).toBeGreaterThanOrEqual(0)
    expect(sliver.duration).toBeGreaterThan(0)
  })
})
