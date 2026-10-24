import { describe, expect, it } from 'vitest'
import {
  jsonDepthExceeds,
  measureOp,
  timelineOpSchema,
  timelineOpsInput,
  timelineOpsSchema,
} from '../../src/timeline-core/schema.js'
import type { TimelineOp } from '../../src/timeline-core/types.js'

const item = {
  id: 'c1',
  trackId: 'trk_captions',
  kind: 'caption',
  label: 'Hello',
  start: 1,
  duration: 2,
  srcIn: 1,
  meta: { text: 'hello', dev: 'हेलो', wordFrom: 0, wordTo: 2, ai: true },
}

/** One valid example of every op, as JSON would carry it. */
const VALID: Record<string, unknown> = {
  trim: { type: 'trim', itemId: 'v1', edge: 'start', to: 3 },
  split: { type: 'split', itemId: 'v1', at: 3, newId: 'v1b' },
  move: { type: 'move', itemId: 'v1', start: 3, trackId: 'trk_overlay' },
  delete: { type: 'delete', itemIds: ['a', 'b'] },
  rippleDelete: { type: 'rippleDelete', from: 1, to: 2, trackIds: ['trk_video'] },
  cutSource: { type: 'cutSource', srcFrom: 1, srcTo: 2 },
  restoreSource: { type: 'restoreSource', srcFrom: 1, srcTo: 2, captions: [item] },
  addCaptions: { type: 'addCaptions', items: [item], replace: true },
  addEffect: {
    type: 'addEffect',
    item: { ...item, kind: 'effect', meta: { effect: 'zoom', amount: 0.4 } },
  },
  setCrop: {
    type: 'setCrop',
    crop: { x: 0.5, y: 0.5, scale: 1.5 },
    keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 1 }],
  },
  setCaptionStyle: { type: 'setCaptionStyle', styleId: 'boxed' },
  setSettings: {
    type: 'setSettings',
    patch: {
      aspect: '1:1',
      captionsOn: true,
      captionFont: 'Inter',
      markers: [{ id: 'm', time: 1, label: 'x' }],
    },
  },
  addMarker: { type: 'addMarker', marker: { id: 'm1', time: 4, label: 'Hook' } },
  removeMarker: { type: 'removeMarker', id: 'm1' },
  patch: { type: 'patch', upsert: [item], remove: ['x'], settings: { captionsOn: true } },
  batch: {
    type: 'batch',
    label: 'tidy',
    ops: [{ type: 'addMarker', marker: { id: 'm', time: 1, label: 'x' } }],
  },
}

const parses = (v: unknown) => timelineOpSchema.safeParse(v).success

describe('the op schema accepts every kind of op', () => {
  for (const [type, op] of Object.entries(VALID)) {
    it(type, () => {
      const parsed = timelineOpSchema.safeParse(op)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      // What comes out is what went in: nothing is dropped or changed.
      expect(parsed.data).toEqual(op)
    })
  }

  it('covers all 16 op types of the front end', () => {
    expect(Object.keys(VALID).sort()).toEqual(
      [
        'addCaptions',
        'addEffect',
        'addMarker',
        'batch',
        'cutSource',
        'delete',
        'move',
        'patch',
        'removeMarker',
        'restoreSource',
        'rippleDelete',
        'setCaptionStyle',
        'setCrop',
        'setSettings',
        'split',
        'trim',
      ].sort(),
    )
  })
})

describe('and refuses anything that is not an op', () => {
  const op = (type: string) => structuredClone(VALID[type]) as Record<string, unknown>

  it('an unknown type, or no type', () => {
    expect(parses({ type: 'launch' })).toBe(false)
    expect(parses({})).toBe(false)
    expect(parses(null)).toBe(false)
    expect(parses('trim')).toBe(false)
    expect(parses([VALID.trim])).toBe(false)
  })

  it('missing fields and wrong types', () => {
    expect(parses({ type: 'trim', itemId: 'v1', edge: 'start' })).toBe(false)
    expect(parses({ ...op('trim'), itemId: 5 })).toBe(false)
    expect(parses({ ...op('trim'), edge: 'middle' })).toBe(false)
    expect(parses({ ...op('delete'), itemIds: 'a' })).toBe(false)
    expect(parses({ ...op('delete'), itemIds: [1] })).toBe(false)
    expect(parses({ ...op('addMarker'), marker: { id: 'm', time: '1', label: 'x' } })).toBe(false)
    expect(parses({ ...op('setCrop'), crop: { x: 0.5, y: 0.5 } })).toBe(false)
  })

  it('numbers that are not finite, or out of any sane range', () => {
    expect(parses({ ...op('trim'), to: Number.NaN })).toBe(false)
    expect(parses({ ...op('trim'), to: Number.POSITIVE_INFINITY })).toBe(false)
    expect(parses({ ...op('trim'), to: 1e12 })).toBe(false)
    expect(parses({ ...op('split'), at: -1 })).toBe(false)
    expect(parses({ ...op('cutSource'), srcFrom: 'abc' })).toBe(false)
  })

  it('an item with impossible values', () => {
    const add = (extra: object) => ({ type: 'addCaptions', items: [{ ...item, ...extra }] })
    expect(parses(add({ start: -1 }))).toBe(false)
    expect(parses(add({ duration: 0 }))).toBe(false)
    expect(parses(add({ duration: -2 }))).toBe(false)
    expect(parses(add({ srcIn: -1 }))).toBe(false)
    expect(parses(add({ kind: 'sound' }))).toBe(false)
    expect(parses(add({ label: 'x'.repeat(201) }))).toBe(false)
    expect(parses(add({ id: '' }))).toBe(false)
    expect(parses(add({ meta: { text: 'x'.repeat(2001) } }))).toBe(false)
    expect(parses(add({ meta: { effect: 'explode' } }))).toBe(false)
  })

  it('extra fields, so nothing can be smuggled into a stored timeline', () => {
    expect(parses({ ...op('trim'), extra: true })).toBe(false)
    expect(parses({ ...op('addCaptions'), items: [{ ...item, secret: 'x' }] })).toBe(false)
    expect(
      parses({ ...op('addCaptions'), items: [{ ...item, meta: { text: 'x', evil: 1 } }] }),
    ).toBe(false)
    expect(parses({ ...op('setSettings'), patch: { isAdmin: true } })).toBe(false)
    expect(parses({ ...op('setCrop'), crop: { x: 0.5, y: 0.5, scale: 1, z: 1 } })).toBe(false)
  })

  it('a prototype-pollution attempt', () => {
    const evil = JSON.parse('{"type":"setSettings","patch":{"__proto__":{"polluted":true}}}')
    expect(parses(evil)).toBe(false)
    const evil2 = JSON.parse('{"type":"trim","itemId":"v","edge":"end","to":1,"__proto__":{"x":1}}')
    expect(parses(evil2)).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('settings out of range', () => {
    expect(parses({ ...op('setSettings'), patch: { aspect: '3:2' } })).toBe(false)
    expect(parses({ ...op('setSettings'), patch: { captionStyleId: '' } })).toBe(false)
    expect(
      parses({
        ...op('setSettings'),
        patch: { keyframes: Array.from({ length: 1001 }, () => ({ t: 0, x: 0, y: 0, scale: 1 })) },
      }),
    ).toBe(false)
  })

  it('too many items in one op', () => {
    const items = Array.from({ length: 5001 }, (_, i) => ({ ...item, id: `c${i}` }))
    expect(parses({ type: 'addCaptions', items })).toBe(false)
    expect(parses({ type: 'delete', itemIds: items.map((i) => i.id) })).toBe(false)
  })
})

describe('a list of ops', () => {
  const nest = (depth: number): TimelineOp => {
    let op: TimelineOp = { type: 'addMarker', marker: { id: 'm', time: 1, label: 'x' } }
    for (let i = 0; i < depth; i++) op = { type: 'batch', ops: [op] }
    return op
  }

  it('needs at least one', () => {
    expect(timelineOpsSchema.safeParse([]).success).toBe(false)
    expect(timelineOpsSchema.safeParse([VALID.trim]).success).toBe(true)
  })

  it('is capped in length', () => {
    expect(timelineOpsSchema.safeParse(Array.from({ length: 200 }, () => VALID.trim)).success).toBe(
      true,
    )
    expect(timelineOpsSchema.safeParse(Array.from({ length: 201 }, () => VALID.trim)).success).toBe(
      false,
    )
  })

  it('refuses batches nested too deeply, and counts ops inside batches', () => {
    expect(measureOp(nest(0))).toEqual({ depth: 1, count: 1 })
    expect(measureOp(nest(3))).toEqual({ depth: 4, count: 4 })
    expect(timelineOpsSchema.safeParse([nest(3)]).success).toBe(true)
    expect(timelineOpsSchema.safeParse([nest(5)]).success).toBe(false)
  })

  it('a deliberately deep payload is refused up front instead of overflowing the validator', () => {
    // timelineOpsSchema alone would recurse thousands of levels; the input guard measures depth first, without recursion.
    const deep = nest(5000)
    expect(jsonDepthExceeds(deep, 40)).toBe(true)
    const started = Date.now()
    const result = timelineOpsInput.safeParse([deep])
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/nested too deeply/)
    expect(Date.now() - started).toBeLessThan(500)
    expect(timelineOpsInput.safeParse([nest(3)]).success).toBe(true)
    // The same for arbitrary junk nested deeply, not just batches.
    let junk: unknown = 'x'
    for (let i = 0; i < 100_000; i++) junk = [junk]
    expect(timelineOpsInput.safeParse(junk).success).toBe(false)
  })

  it('measures depth correctly', () => {
    expect(jsonDepthExceeds({ a: [{ b: 1 }] }, 3)).toBe(false)
    expect(jsonDepthExceeds({ a: [{ b: 1 }] }, 2)).toBe(true)
    expect(jsonDepthExceeds('flat', 1)).toBe(false)
    expect(jsonDepthExceeds([], 1)).toBe(false)
  })

  it('caps the total number of ops, however they are grouped', () => {
    const wide: TimelineOp = {
      type: 'batch',
      ops: Array.from({ length: 500 }, () => ({ type: 'removeMarker', id: 'm' }) as TimelineOp),
    }
    expect(timelineOpsSchema.safeParse([wide, wide, wide]).success).toBe(true)
    expect(timelineOpsSchema.safeParse([wide, wide, wide, wide, wide]).success).toBe(false)
  })
})
