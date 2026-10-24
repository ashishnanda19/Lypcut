import { describe, expect, it } from 'vitest'
import { sameTimeline } from '@lypcut/timeline-core'
import {
  applyOp,
  assertInvariants,
  changedItemIds,
  describeTimeline,
  inverseConflicts,
  MAX_ITEMS,
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
import type { Timeline, TimelineOp } from '@lypcut/timeline-core'
import { buildInitialTimeline } from '@lypcut/timeline-core'
import { captionItems, clone, deepFreeze, prng, sampleTimeline } from '../helpers/timeline.js'

const { timeline: tl, words } = sampleTimeline()
const vids = trackItems(tl, 'trk_video')
const auds = trackItems(tl, 'trk_audio')
const brolls = trackItems(tl, 'trk_broll')

/** One representative, valid op of every type, against the sample timeline. */
const EVERY_OP: Array<[string, TimelineOp]> = [
  ['trim (start)', { type: 'trim', itemId: vids[1]!.id, edge: 'start', to: vids[1]!.start + 3 }],
  ['trim (end)', { type: 'trim', itemId: vids[1]!.id, edge: 'end', to: itemEnd(vids[1]!) - 4 }],
  ['split', { type: 'split', itemId: vids[2]!.id, at: vids[2]!.start + 10, newId: 'split_1' }],
  ['split (generated id)', { type: 'split', itemId: vids[2]!.id, at: vids[2]!.start + 10 }],
  ['move', { type: 'move', itemId: brolls[0]!.id, start: brolls[0]!.start + 2 }],
  [
    'move (to another track)',
    { type: 'move', itemId: brolls[0]!.id, start: brolls[0]!.start, trackId: 'trk_overlay' },
  ],
  ['delete', { type: 'delete', itemIds: [brolls[0]!.id, brolls[1]!.id] }],
  ['rippleDelete', { type: 'rippleDelete', from: 20, to: 50 }],
  [
    'rippleDelete (some tracks)',
    { type: 'rippleDelete', from: 20, to: 50, trackIds: ['trk_video', 'trk_audio'] },
  ],
  ['cutSource', { type: 'cutSource', srcFrom: 30, srcTo: 90 }],
  ['addCaptions', { type: 'addCaptions', items: captionItems(0, 20) }],
  [
    'addCaptions (replace)',
    { type: 'addCaptions', items: captionItems(0, 10, 'r'), replace: true },
  ],
  [
    'addEffect',
    {
      type: 'addEffect',
      item: {
        id: 'fx1',
        trackId: 'trk_effects',
        kind: 'effect',
        label: 'Zoom',
        start: 10,
        duration: 3,
        srcIn: 0,
        meta: { effect: 'zoom', amount: 0.4 },
      },
    },
  ],
  ['setCrop', { type: 'setCrop', crop: { x: 0.7, y: 0.4, scale: 1.5 } }],
  [
    'setCrop (with keyframes)',
    {
      type: 'setCrop',
      crop: { x: 0.6, y: 0.5, scale: 2 },
      keyframes: [
        { t: 0, x: 0.5, y: 0.5, scale: 1 },
        { t: 5, x: 0.6, y: 0.5, scale: 2 },
      ],
    },
  ],
  ['setCaptionStyle', { type: 'setCaptionStyle', styleId: 'boxed' }],
  [
    'setSettings',
    {
      type: 'setSettings',
      patch: { aspect: '1:1', captionFont: 'Inter', captionAccent: '#ffa83a' },
    },
  ],
  ['addMarker', { type: 'addMarker', marker: { id: 'm1', time: 10, label: 'Hook' } }],
  [
    'patch',
    {
      type: 'patch',
      upsert: [{ ...vids[0]!, label: 'Renamed' }],
      remove: [brolls[2]!.id],
      settings: { captionsOn: true },
    },
  ],
  [
    'batch',
    {
      type: 'batch',
      label: 'Tidy up',
      ops: [
        { type: 'rippleDelete', from: 5, to: 8 },
        { type: 'rippleDelete', from: 40, to: 44 },
        { type: 'addMarker', marker: { id: 'm2', time: 12, label: 'x' } },
      ],
    },
  ],
  [
    'nested batch',
    {
      type: 'batch',
      ops: [
        { type: 'batch', ops: [{ type: 'addMarker', marker: { id: 'm3', time: 1, label: 'a' } }] },
        { type: 'setCaptionStyle', styleId: 'karaoke' },
      ],
    },
  ],
]

const withCaptions = (): Timeline =>
  applyOp(tl, { type: 'addCaptions', items: captionItems(60, 100) }).timeline
const withMarker = (): Timeline =>
  applyOp(tl, { type: 'addMarker', marker: { id: 'mk', time: 3, label: 'here' } }).timeline

describe('every op type is reversible', () => {
  for (const [name, op] of EVERY_OP) {
    it(`${name}: applying the inverse returns exactly the original`, () => {
      const forward = applyOp(tl, op, { newId: sequentialIds('n_') })
      expect(sameTimeline(forward.timeline, tl), 'the op should change something').toBe(false)
      const back = applyOp(forward.timeline, forward.inverse)
      expect(sameTimeline(back.timeline, tl)).toBe(true)
    })

    it(`${name}: and redo (the inverse of the inverse) returns the edited timeline`, () => {
      const forward = applyOp(tl, op, { newId: sequentialIds('n_') })
      const undone = applyOp(forward.timeline, forward.inverse)
      const redone = applyOp(undone.timeline, undone.inverse)
      expect(sameTimeline(redone.timeline, forward.timeline)).toBe(true)
    })
  }

  it('removeMarker', () => {
    const base = withMarker()
    const forward = applyOp(base, { type: 'removeMarker', id: 'mk' })
    expect(forward.timeline.settings.markers).toEqual([])
    expect(sameTimeline(applyOp(forward.timeline, forward.inverse).timeline, base)).toBe(true)
  })

  it('restoreSource, with the captions it brings back', () => {
    const captioned = withCaptions()
    const cut = applyOp(captioned, { type: 'cutSource', srcFrom: 70, srcTo: 85 })
    const restore: TimelineOp = {
      type: 'restoreSource',
      srcFrom: 70,
      srcTo: 85,
      captions: captionItems(70, 85, 'rc'),
    }
    const forward = applyOp(cut.timeline, restore, { newId: sequentialIds('r_') })
    const back = applyOp(forward.timeline, forward.inverse)
    expect(sameTimeline(back.timeline, cut.timeline)).toBe(true)
  })

  it('a batch undoes as one step, and equals undoing its parts in reverse', () => {
    const batch = EVERY_OP.find(([n]) => n === 'batch')![1] as Extract<
      TimelineOp,
      { type: 'batch' }
    >
    const whole = applyOp(tl, batch)
    const asOne = applyOp(whole.timeline, whole.inverse).timeline
    let cur = tl
    const inverses = batch.ops.map((o) => {
      const r = applyOp(cur, o)
      cur = r.timeline
      return r.inverse
    })
    for (const inv of inverses.reverse()) cur = applyOp(cur, inv).timeline
    expect(sameTimeline(asOne, tl)).toBe(true)
    expect(sameTimeline(cur, tl)).toBe(true)
  })

  it('an empty batch changes nothing and has an empty inverse', () => {
    const r = applyOp(tl, { type: 'batch', ops: [] })
    expect(sameTimeline(r.timeline, tl)).toBe(true)
    expect(r.inverse).toEqual({ type: 'patch', upsert: [], remove: [] })
  })
})

describe('what each op does', () => {
  it('split divides a clip in two, the second half carrying the right source time', () => {
    const v = vids[2]!
    const r = applyOp(tl, { type: 'split', itemId: v.id, at: v.start + 10, newId: 'x1' })
    expect(r.timeline.items[v.id]!.duration).toBeCloseTo(10)
    expect(r.timeline.items.x1).toMatchObject({
      start: v.start + 10,
      srcIn: v.srcIn + 10,
      duration: v.duration - 10,
    })
    expect(Object.keys(r.timeline.items)).toHaveLength(Object.keys(tl.items).length + 1)
  })

  it('trim moves an edge, keeping what remains on the same source frames', () => {
    const v = vids[1]!
    const s = applyOp(tl, { type: 'trim', itemId: v.id, edge: 'start', to: v.start + 3 }).timeline
      .items[v.id]!
    expect(s).toMatchObject({ start: v.start + 3, srcIn: v.srcIn + 3 })
    expect(s.duration).toBeCloseTo(v.duration - 3)
    const e = applyOp(tl, { type: 'trim', itemId: v.id, edge: 'end', to: itemEnd(v) - 4 }).timeline
      .items[v.id]!
    expect(e.duration).toBeCloseTo(v.duration - 4)
    expect(e.srcIn).toBe(v.srcIn)
  })

  it('trim cannot reveal footage before the start of the source or past its end', () => {
    const first = applyOp(tl, { type: 'trim', itemId: vids[0]!.id, edge: 'start', to: -50 })
      .timeline.items[vids[0]!.id]!
    expect(first.srcIn).toBeGreaterThanOrEqual(0)
    const last = vids[vids.length - 1]!
    const grown = applyOp(tl, { type: 'trim', itemId: last.id, edge: 'end', to: 99_999 }).timeline
      .items[last.id]!
    expect(itemEnd(grown)).toBeLessThanOrEqual(tl.sourceDuration + 1e-6)
  })

  it('trimming a clip that is already shorter than the minimum leaves it where it is, never at a negative time', () => {
    // A sliver like this is left behind by an earlier cut. The front end's engine, given a start-trim here, moves
    // it to before zero; the server must not store that.
    const sliver: Timeline = {
      ...tl,
      items: {
        ...tl.items,
        [vids[0]!.id]: { ...vids[0]!, duration: 0.035 },
        [auds[0]!.id]: { ...auds[0]!, duration: 0.035 },
      },
    }
    const r = applyOp(sliver, { type: 'trim', itemId: vids[0]!.id, edge: 'start', to: 0.0127 })
    const out = r.timeline.items[vids[0]!.id]!
    expect(out.start).toBeGreaterThanOrEqual(0)
    expect(out.srcIn).toBeGreaterThanOrEqual(0)
    expect(out.duration).toBeGreaterThan(0)
    assertInvariants(r.timeline)
  })

  it('trim never makes a clip shorter than the minimum', () => {
    const v = vids[1]!
    const r = applyOp(tl, { type: 'trim', itemId: v.id, edge: 'end', to: v.start }).timeline.items[
      v.id
    ]!
    expect(r.duration).toBeGreaterThanOrEqual(0.1 - 1e-9)
  })

  it('ripple delete shifts everything after the range and closes the gap', () => {
    const before = timelineDuration(tl)
    const r = applyOp(tl, { type: 'rippleDelete', from: 20, to: 30 })
    expect(timelineDuration(r.timeline)).toBeCloseTo(before - 10, 1)
    expect(srcTimeAt(r.timeline, 20)).toBeCloseTo(30, 1)
  })

  it('ripple delete leaves locked tracks alone', () => {
    const locked: Timeline = {
      ...tl,
      tracks: tl.tracks.map((t) => (t.id === 'trk_broll' ? { ...t, locked: true } : t)),
    }
    const r = applyOp(locked, { type: 'rippleDelete', from: 10, to: 20 })
    for (const b of brolls) expect(r.timeline.items[b.id]).toEqual(b)
  })

  it('cutting a source range removes it everywhere and the voice moves in lockstep', () => {
    const r = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    expect(timelineDuration(r.timeline)).toBeCloseTo(timelineDuration(tl) - 12, 1)
    expect(timeAtSource(r.timeline, 35)).toBeUndefined()
    expect(timeAtSource(r.timeline, 45)).toBeCloseTo(33, 1)
    const flags = cutFlags(r.timeline, words)
    expect(words.filter((w, i) => flags[i] && w.start >= 30 && w.end <= 42).length).toBeGreaterThan(
      15,
    )
    expect(Math.max(...trackItems(r.timeline, 'trk_audio').map(itemEnd))).toBeCloseTo(
      timelineDuration(r.timeline),
      1,
    )
  })

  it('cut then restore returns the same coverage, duration and clip count', () => {
    // 40-50 lies inside one scene, so cutting splits its clip and restoring joins the pieces again.
    const cut = applyOp(tl, { type: 'cutSource', srcFrom: 40, srcTo: 50 })
    expect(trackItems(cut.timeline, 'trk_video').length).toBe(vids.length + 1)
    const back = applyOp(cut.timeline, { type: 'restoreSource', srcFrom: 40, srcTo: 50 })
    expect(timelineDuration(back.timeline)).toBeCloseTo(timelineDuration(tl), 1)
    expect(coverage(back.timeline)).toEqual(coverage(tl))
    expect(trackItems(back.timeline, 'trk_video').length).toBe(vids.length)
    expect(timeAtSource(back.timeline, 45)).toBeCloseTo(45, 1)
  })

  it('restoring a range that crosses a scene boundary joins the two clips it touches', () => {
    const cut = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const back = applyOp(cut.timeline, { type: 'restoreSource', srcFrom: 30, srcTo: 42 })
    expect(coverage(back.timeline)).toEqual(coverage(tl))
    expect(timelineDuration(back.timeline)).toBeCloseTo(timelineDuration(tl), 1)
    // One clip fewer than before: the pieces either side of the old boundary are now one continuous clip.
    expect(trackItems(back.timeline, 'trk_video').length).toBe(vids.length - 1)
  })

  it('cutting the same range twice is a no-op, not an error', () => {
    const once = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const twice = applyOp(once.timeline, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    expect(timelineDuration(twice.timeline)).toBeCloseTo(timelineDuration(once.timeline), 3)
  })

  it('addCaptions turns captions on, and replace clears the old ones first', () => {
    const a = applyOp(tl, { type: 'addCaptions', items: captionItems(0, 5) }).timeline
    expect(a.settings.captionsOn).toBe(true)
    const b = applyOp(a, {
      type: 'addCaptions',
      items: captionItems(10, 12, 'z'),
      replace: true,
    }).timeline
    expect(trackItems(b, 'trk_captions').map((c) => c.id)).toEqual(['z10', 'z11'])
  })

  it('setCaptionStyle also turns captions on', () => {
    const r = applyOp(tl, { type: 'setCaptionStyle', styleId: 'boxed' }).timeline.settings
    expect(r).toMatchObject({ captionStyleId: 'boxed', captionsOn: true })
  })

  it('moves a clip to another track of a compatible kind', () => {
    const r = applyOp(tl, { type: 'move', itemId: brolls[0]!.id, start: 3, trackId: 'trk_overlay' })
    expect(r.timeline.items[brolls[0]!.id]).toMatchObject({ trackId: 'trk_overlay', start: 3 })
  })
})

describe('the engine does not change what it is given', () => {
  it('leaves the input timeline and the op untouched (both frozen: any write would throw)', () => {
    const frozenTl = deepFreeze(clone(tl))
    for (const [name, op] of EVERY_OP) {
      const frozenOp = deepFreeze(clone(op))
      expect(() => applyOp(frozenTl, frozenOp, { newId: sequentialIds('n_') }), name).not.toThrow()
    }
  })

  it('returns an inverse that does not share objects with the new timeline', () => {
    const r = applyOp(tl, {
      type: 'trim',
      itemId: vids[1]!.id,
      edge: 'end',
      to: itemEnd(vids[1]!) - 4,
    })
    expect(r.inverse.upsert[0]).toEqual(vids[1])
    expect(r.timeline.items[vids[1]!.id]).not.toBe(r.inverse.upsert[0])
  })
})

describe('ids are deterministic when asked to be', () => {
  const ops: TimelineOp[] = [
    { type: 'rippleDelete', from: 17, to: 23 },
    { type: 'rippleDelete', from: 80, to: 84 },
    { type: 'split', itemId: vids[5]!.id, at: vids[5]!.start + 7 },
  ]
  const run = (prefix: string) => {
    const gen = sequentialIds(prefix)
    let cur = tl
    for (const op of ops) cur = applyOp(cur, op, { newId: gen }).timeline
    return cur
  }

  it('the same ops with the same generator give the identical timeline, every time', () => {
    expect(sameTimeline(run('i_v1_'), run('i_v1_'))).toBe(true)
  })

  it('a different prefix changes only the ids it makes', () => {
    const a = run('i_v1_')
    const b = run('i_v2_')
    expect(Object.keys(a.items).filter((k) => k.startsWith('i_v1_')).length).toBeGreaterThan(0)
    expect(Object.keys(b.items).filter((k) => k.startsWith('i_v2_'))).toHaveLength(
      Object.keys(a.items).filter((k) => k.startsWith('i_v1_')).length,
    )
  })

  it('a split cannot be given the id of a clip that already exists', () => {
    expect(() =>
      applyOp(tl, {
        type: 'split',
        itemId: vids[1]!.id,
        at: vids[1]!.start + 5,
        newId: vids[2]!.id,
      }),
    ).toThrow(/already exists/)
  })
})

/** The same timeline with its items stored in a different key order, as a database round trip can leave them. */
function reorder(source: Timeline, rand: () => number): Timeline {
  const ids = Object.keys(source.items)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  }
  return { ...source, items: Object.fromEntries(ids.map((id) => [id, source.items[id]!])) }
}

describe('results never depend on the order items happen to be stored in', () => {
  // Postgres jsonb does not keep keys in insertion order. If ids, or anything else, depended on it, the server and a
  // client holding the same timeline could disagree about the very same edit. Found by a model-based test.
  it('every op gives the identical result, ids included, however the keys are ordered', () => {
    for (const [name, op] of EVERY_OP) {
      const a = applyOp(tl, op, { newId: sequentialIds('n_') })
      for (const seed of [1, 2, 3]) {
        const b = applyOp(reorder(tl, prng(seed)), op, { newId: sequentialIds('n_') })
        expect(sameTimeline(b.timeline, a.timeline), `${name} (order ${seed})`).toBe(true)
        expect(sameTimeline({ ...tl, items: {} }, { ...tl, items: {} })).toBe(true)
        expect(JSON.stringify(b.inverse.remove.sort())).toBe(
          JSON.stringify(a.inverse.remove.sort()),
        )
      }
    }
  })

  it('a long random history is identical when replayed on a reordered timeline at every step', () => {
    const rand = prng(99)
    const ids = (v: number) => sequentialIds(`s${v}_`)
    let plain = tl
    let shuffled = tl
    for (let i = 0; i < 80; i++) {
      const clips = Object.values(plain.items).filter((x) => x.kind === 'video')
      const clip = clips[Math.floor(rand() * clips.length)] ?? Object.values(plain.items)[0]!
      const ops: TimelineOp[] = [
        { type: 'rippleDelete', from: rand() * 200, to: rand() * 200 + 2 },
        { type: 'cutSource', srcFrom: rand() * 250, srcTo: rand() * 250 + 3 },
        { type: 'restoreSource', srcFrom: rand() * 250, srcTo: rand() * 250 + 3 },
        { type: 'split', itemId: clip.id, at: clip.start + clip.duration * (0.2 + rand() * 0.6) },
      ]
      const op = ops[Math.floor(rand() * ops.length)]!
      let a
      let b
      try {
        a = applyOp(plain, op, { newId: ids(i) })
      } catch {
        a = null
      }
      try {
        b = applyOp(shuffled, op, { newId: ids(i) })
      } catch {
        b = null
      }
      expect(a === null, `step ${i}: both refuse or both accept`).toBe(b === null)
      if (a && b) {
        expect(sameTimeline(a.timeline, b.timeline), `step ${i}`).toBe(true)
        plain = a.timeline
        shuffled = reorder(b.timeline, rand)
      }
    }
  })
})

describe('invalid ops are refused, say why, and change nothing', () => {
  const refuse = (op: TimelineOp, message?: RegExp, base: Timeline = tl) => {
    const before = JSON.stringify(base)
    expect(() => applyOp(base, op)).toThrow(OpError)
    if (message) expect(() => applyOp(base, op)).toThrow(message)
    expect(JSON.stringify(base)).toBe(before)
    expect(validateOp(base, op)).toHaveLength(1)
  }

  it('overlaps on the same track', () => {
    refuse({ type: 'move', itemId: vids[1]!.id, start: vids[0]!.start + 1 }, /overlap/)
    refuse({ type: 'trim', itemId: vids[0]!.id, edge: 'end', to: vids[1]!.start + 5 }, /overlap/)
  })

  it('a clip on a track it does not belong on', () => {
    refuse(
      { type: 'move', itemId: vids[1]!.id, start: vids[1]!.start, trackId: 'trk_audio' },
      /belong/,
    )
    refuse(
      { type: 'move', itemId: vids[1]!.id, start: 0, trackId: 'no_such_track' },
      /does not exist/,
    )
  })

  it('bad or impossible times', () => {
    refuse({ type: 'move', itemId: vids[1]!.id, start: -3 }, /before zero/)
    refuse({ type: 'trim', itemId: vids[1]!.id, edge: 'end', to: Number.NaN }, /numbers/)
    refuse({ type: 'split', itemId: vids[0]!.id, at: Number.POSITIVE_INFINITY }, /numbers/)
    refuse({ type: 'split', itemId: vids[0]!.id, at: vids[0]!.start + 0.01 }, /playhead/)
    refuse({ type: 'split', itemId: vids[0]!.id, at: itemEnd(vids[0]!) + 5 }, /playhead/)
    refuse({ type: 'rippleDelete', from: 9, to: 3 }, /range/)
    refuse({ type: 'rippleDelete', from: -1, to: 3 }, /range/)
    refuse({ type: 'cutSource', srcFrom: 9, srcTo: 9 }, /range/)
    refuse({ type: 'restoreSource', srcFrom: 0, srcTo: 99_999 }, /does not exist/)
    refuse({ type: 'restoreSource', srcFrom: -5, srcTo: 10 }, /does not exist/)
  })

  it('clips that do not exist', () => {
    refuse({ type: 'trim', itemId: 'nope', edge: 'end', to: 4 }, /not found/)
    refuse({ type: 'delete', itemIds: [vids[0]!.id, 'nope'] }, /not found/)
    refuse({ type: 'move', itemId: 'nope', start: 1 }, /not found/)
    refuse({ type: 'split', itemId: 'nope', at: 1 }, /not found/)
  })

  it('a crop outside the frame or an impossible zoom', () => {
    refuse({ type: 'setCrop', crop: { x: 2, y: 0.5, scale: 1 } }, /inside the frame/)
    refuse({ type: 'setCrop', crop: { x: 0.5, y: -1, scale: 1 } }, /inside the frame/)
    refuse({ type: 'setCrop', crop: { x: 0.5, y: 0.5, scale: 9 } }, /between 1x and 4x/)
    refuse({ type: 'setCrop', crop: { x: 0.5, y: 0.5, scale: 0.5 } }, /between 1x and 4x/)
  })

  it('the wrong kind of clip on the captions or effects track', () => {
    refuse({ type: 'addCaptions', items: [{ ...vids[0]!, id: 'sneaky' }] }, /Only captions/)
    refuse({ type: 'addEffect', item: { ...vids[0]!, id: 'sneaky' } }, /Only effects/)
  })

  it('a project with no captions or effects track', () => {
    const bare: Timeline = {
      ...tl,
      tracks: tl.tracks.filter((t) => t.kind !== 'captions' && t.kind !== 'effects'),
    }
    refuse({ type: 'addCaptions', items: [] }, /no captions track/, bare)
    refuse(
      {
        type: 'addEffect',
        item: {
          id: 'x',
          trackId: 'x',
          kind: 'effect',
          label: 'x',
          start: 1,
          duration: 1,
          srcIn: 0,
        },
      },
      /no effects track/,
      bare,
    )
  })

  it('edits on a locked track', () => {
    const locked: Timeline = {
      ...tl,
      tracks: tl.tracks.map((t) => (t.id === 'trk_video' ? { ...t, locked: true } : t)),
    }
    refuse({ type: 'delete', itemIds: [vids[0]!.id] }, /locked/, locked)
    refuse({ type: 'trim', itemId: vids[0]!.id, edge: 'end', to: 5 }, /locked/, locked)
    refuse({ type: 'split', itemId: vids[0]!.id, at: 10 }, /locked/, locked)
    refuse({ type: 'move', itemId: vids[0]!.id, start: 1 }, /locked/, locked)
  })

  it('a batch where one op is bad changes nothing, including the ops before it', () => {
    const before = JSON.stringify(tl)
    expect(() =>
      applyOp(tl, {
        type: 'batch',
        ops: [
          { type: 'addMarker', marker: { id: 'm', time: 1, label: 'x' } },
          { type: 'delete', itemIds: ['nope'] },
        ],
      }),
    ).toThrow(OpError)
    expect(JSON.stringify(tl)).toBe(before)
  })

  it('validateOp reports a problem without applying, and reports nothing for a good op', () => {
    expect(validateOp(tl, { type: 'addMarker', marker: { id: 'm', time: 1, label: 'x' } })).toEqual(
      [],
    )
    expect(validateOp(tl, { type: 'delete', itemIds: ['nope'] })).toEqual([
      'Clip nope was not found.',
    ])
  })

  it('a bug in the engine is not mistaken for a bad op', () => {
    // validateOp only swallows OpError; anything else (a TypeError from garbage) is allowed to surface.
    expect(() => validateOp(tl, { type: 'batch', ops: null } as unknown as TimelineOp)).toThrow(
      TypeError,
    )
  })
})

describe('the invariants that hold after any op', () => {
  const patch = (item: Partial<(typeof vids)[number]> & { id: string }): TimelineOp => ({
    type: 'patch',
    upsert: [{ ...vids[0]!, ...item }],
    remove: [],
  })

  it('a patch cannot put a clip on a track that does not exist, or one it does not fit', () => {
    expect(() => applyOp(tl, patch({ id: 'p1', trackId: 'ghost' }))).toThrow(/does not exist/)
    expect(() => applyOp(tl, patch({ id: 'p2', trackId: 'trk_audio' }))).toThrow(/belong/)
  })

  it('a patch cannot produce a clip with impossible times', () => {
    expect(() => applyOp(tl, patch({ id: 'p3', start: -1 }))).toThrow(/before zero/)
    expect(() => applyOp(tl, patch({ id: 'p4', srcIn: -2 }))).toThrow(/beginning/)
    expect(() => applyOp(tl, patch({ id: 'p5', duration: 0 }))).toThrow(/length/)
    expect(() => applyOp(tl, patch({ id: 'p6', start: Number.NaN }))).toThrow(/numbers/)
  })

  it('a clip’s key must be its id', () => {
    const bad: Timeline = { ...tl, items: { ...tl.items, wrong_key: { ...vids[0]!, id: 'other' } } }
    expect(() => assertInvariants(bad)).toThrow(/mismatched/)
  })

  it('a timeline has a size limit', () => {
    const items: Timeline['items'] = {}
    for (let i = 0; i <= MAX_ITEMS; i++) {
      items[`m${i}`] = {
        id: `m${i}`,
        trackId: 'trk_video',
        kind: 'video',
        label: 'x',
        start: i,
        duration: 0.5,
        srcIn: 0,
      }
    }
    expect(() => assertInvariants({ ...tl, items })).toThrow(/at most/)
  })

  it('holds after every op in the table', () => {
    for (const [, op] of EVERY_OP)
      assertInvariants(applyOp(tl, op, { newId: sequentialIds('n_') }).timeline)
  })
})

describe('queries', () => {
  it('map between timeline time and source time, both ways, across a cut', () => {
    const cut = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 }).timeline
    expect(srcTimeAt(cut, 10)).toBeCloseTo(10)
    expect(srcTimeAt(cut, 31)).toBeCloseTo(43)
    expect(timeAtSource(cut, 35)).toBeUndefined()
    expect(timeAtSource(cut, 43)).toBeCloseTo(31)
    expect(srcTimeAt(cut, 99_999)).toBeUndefined()
  })

  it('coverage merges touching clips, and describeTimeline summarises', () => {
    expect(coverage(tl)).toEqual([[0, 280]])
    const d = describeTimeline(tl)
    expect(d).toEqual({ duration: 280, clips: Object.keys(tl.items).length })
  })

  it('flag the words that were cut', () => {
    const cut = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 }).timeline
    const flags = cutFlags(cut, words)
    expect(flags[0]).toBe(0)
    expect(flags[70]).toBe(1) // 35 s
    expect(flags[100]).toBe(0)
  })

  it('changedItemIds tells what an op added and changed', () => {
    const after = applyOp(tl, {
      type: 'split',
      itemId: vids[2]!.id,
      at: vids[2]!.start + 10,
      newId: 'x1',
    }).timeline
    expect(changedItemIds(tl, after)).toEqual({ added: ['x1'], changed: [vids[2]!.id] })
  })
})

describe('selective undo knows when later edits are in the way', () => {
  it('detects when a later edit touched the same clips, and not otherwise', () => {
    const a = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    const b = applyOp(a.timeline, { type: 'cutSource', srcFrom: 100, srcTo: 108 })
    expect(inverseConflicts(a.timeline, a.timeline, a.inverse)).toBe(false)
    expect(inverseConflicts(b.timeline, a.timeline, a.inverse)).toBe(true)
    const markerOnly = applyOp(a.timeline, {
      type: 'addMarker',
      marker: { id: 'q', time: 1, label: 'q' },
    })
    expect(inverseConflicts(markerOnly.timeline, a.timeline, a.inverse)).toBe(false)
  })

  it('compares by value, so a timeline reloaded from storage still matches', () => {
    const a = applyOp(tl, { type: 'cutSource', srcFrom: 30, srcTo: 42 })
    expect(inverseConflicts(clone(a.timeline), a.timeline, a.inverse)).toBe(false)
  })

  it('notices a changed setting too', () => {
    const a = applyOp(tl, { type: 'setCrop', crop: { x: 0.6, y: 0.5, scale: 1.2 } })
    const b = applyOp(a.timeline, { type: 'setCrop', crop: { x: 0.8, y: 0.5, scale: 1.2 } })
    expect(inverseConflicts(b.timeline, a.timeline, a.inverse)).toBe(true)
  })
})

describe('fuzz: random edits can always be undone, to the exact original', () => {
  /** A random op that is usually valid. Invalid ones are fine: they must be refused without changing anything. */
  function randomOp(rand: () => number, cur: Timeline): TimelineOp {
    const items = Object.values(cur.items)
    const pick = () => items[Math.floor(rand() * items.length)]!
    const v = items.filter((i) => i.kind === 'video')
    const clip = v[Math.floor(rand() * v.length)] ?? pick()
    const dur = timelineDuration(cur) || 1
    switch (Math.floor(rand() * 11)) {
      case 0:
        return {
          type: 'split',
          itemId: clip.id,
          at: clip.start + clip.duration * (0.2 + rand() * 0.6),
        }
      case 1:
        return {
          type: 'trim',
          itemId: clip.id,
          edge: rand() < 0.5 ? 'start' : 'end',
          to: clip.start + clip.duration * rand(),
        }
      case 2:
        return { type: 'move', itemId: pick().id, start: rand() * dur }
      case 3:
        return { type: 'delete', itemIds: [pick().id] }
      case 4: {
        const from = rand() * dur * 0.8
        return { type: 'rippleDelete', from, to: from + 0.5 + rand() * 8 }
      }
      case 5: {
        const a = rand() * tl.sourceDuration * 0.9
        return { type: 'cutSource', srcFrom: a, srcTo: a + 0.5 + rand() * 12 }
      }
      case 6: {
        const a = rand() * tl.sourceDuration * 0.9
        return { type: 'restoreSource', srcFrom: a, srcTo: a + 0.5 + rand() * 12 }
      }
      case 7:
        return {
          type: 'addMarker',
          marker: { id: `mk${Math.floor(rand() * 1e6)}`, time: rand() * dur, label: 'm' },
        }
      case 8:
        return { type: 'setCrop', crop: { x: rand(), y: rand(), scale: 1 + rand() * 3 } }
      case 9:
        return {
          type: 'addCaptions',
          items: captionItems(
            Math.floor(rand() * 200),
            Math.floor(rand() * 200) + 3,
            `f${Math.floor(rand() * 1e5)}_`,
          ),
        }
      default:
        return { type: 'batch', ops: [randomOp(rand, cur), randomOp(rand, cur)] }
    }
  }

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 120 random edits, then every inverse in reverse order`, () => {
      const rand = prng(seed)
      const ids = sequentialIds(`z${seed}_`)
      let cur = tl
      const trail: Array<{ inverse: TimelineOp; before: Timeline }> = []
      let applied = 0
      let refused = 0
      for (let i = 0; i < 120; i++) {
        const op = randomOp(rand, cur)
        const snapshot = JSON.stringify(cur)
        try {
          const r = applyOp(cur, op, { newId: ids })
          assertInvariants(r.timeline)
          trail.push({ inverse: r.inverse, before: cur })
          cur = r.timeline
          applied++
        } catch (e) {
          expect(e, `op ${JSON.stringify(op)}`).toBeInstanceOf(OpError)
          // A refused op leaves the timeline exactly as it was.
          expect(JSON.stringify(cur)).toBe(snapshot)
          refused++
        }
      }
      expect(applied).toBeGreaterThan(30)
      expect(refused).toBeGreaterThan(0)

      for (const step of trail.reverse()) {
        cur = applyOp(cur, step.inverse).timeline
        expect(sameTimeline(cur, step.before)).toBe(true)
      }
      expect(sameTimeline(cur, tl)).toBe(true)
    })
  }
})

describe('performance: 500 operations on a 300-clip timeline', () => {
  it('stays well inside a frame budget per op', () => {
    // 300 scenes of 12 s: the same size of timeline the front end's own performance test uses.
    let cur = buildInitialTimeline(
      Array.from({ length: 300 }, (_, i) => ({
        id: `p${i}`,
        label: `S${i}`,
        start: i * 12,
        end: (i + 1) * 12,
      })),
      3600,
    )
    const ids = sequentialIds('perf_')
    const started = performance.now()
    for (let i = 0; i < 500; i++) {
      const vs = trackItems(cur, 'trk_video')
      const v = vs[(i * 7) % vs.length]!
      const op: TimelineOp =
        i % 3 === 0
          ? { type: 'split', itemId: v.id, at: v.start + v.duration / 2 }
          : i % 3 === 1
            ? { type: 'trim', itemId: v.id, edge: 'end', to: itemEnd(v) - 0.2 }
            : { type: 'addMarker', marker: { id: `m${i}`, time: v.start, label: 'm' } }
      cur = applyOp(cur, op, { newId: ids }).timeline
    }
    expect((performance.now() - started) / 500).toBeLessThan(50)
    expect(Object.keys(cur.items).length).toBeGreaterThan(600)
  })
})
