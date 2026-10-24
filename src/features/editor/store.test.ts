import { beforeEach, describe, expect, it } from 'vitest'
import type { EditPlan } from '@/types'
import { fixture } from '@/lib/timeline/fixtures'
import { removeFillersOp } from '@/lib/timeline/transcript'
import { buildStressTimeline } from '@/lib/timeline/build'
import { timelineDuration, trackItems } from '@/lib/timeline/queries'
import { canRedo, canUndo, editStatus, headTimeline, shownTimeline, useEditor } from './store'

const { words, timeline } = fixture()
const st = () => useEditor.getState()

function fillerPlan(): EditPlan {
  const r = removeFillersOp(headTimeline(st()), words)!
  return { id: 'e1', title: 'Remove fillers', description: '', op: r.op, strip: [], summary: [] }
}

beforeEach(() => {
  st().reset()
  st().open(`p_${Math.random()}`, timeline, [])
})

describe('editor store', () => {
  it('starts with one version and nothing to undo', () => {
    expect(st().versions).toHaveLength(1)
    expect(canUndo(st())).toBe(false)
  })

  it('commits ops as versions and undoes and redoes them', () => {
    const first = trackItems(timeline, 'trk_broll')[0]!
    const r = st().commit(
      { type: 'move', itemId: first.id, start: first.start + 3 },
      { author: 'you', label: 'Moved' },
    )
    expect(r.ok).toBe(true)
    expect(headTimeline(st()).items[first.id]!.start).toBe(first.start + 3)
    st().undo()
    expect(headTimeline(st()).items[first.id]!.start).toBe(first.start)
    expect(canRedo(st())).toBe(true)
    st().redo()
    expect(headTimeline(st()).items[first.id]!.start).toBe(first.start + 3)
  })

  it('rejects an invalid op and changes nothing', () => {
    const r = st().commit({ type: 'move', itemId: 'nope', start: 1 }, { author: 'you', label: 'x' })
    expect(r.ok).toBe(false)
    expect(st().versions).toHaveLength(1)
  })

  it('keeps abandoned versions when you edit after undoing', () => {
    const [a, b] = trackItems(timeline, 'trk_broll')
    st().commit({ type: 'move', itemId: a!.id, start: 1 }, { author: 'you', label: 'A' })
    st().undo()
    st().commit({ type: 'move', itemId: b!.id, start: 2 }, { author: 'you', label: 'B' })
    expect(st().versions.map((v) => v.label)).toEqual(['Original upload', 'B'])
    expect(st().archived.map((v) => v.label)).toEqual(['A'])
    const restored = st().restore(st().archived[0]!.id)
    expect(restored.ok).toBe(true)
    expect(headTimeline(st()).items[a!.id]!.start).toBe(1)
    expect(headTimeline(st()).items[b!.id]!.start).toBe(b!.start)
  })

  it('restore brings back an earlier version without deleting later ones', () => {
    const first = trackItems(timeline, 'trk_broll')[0]!
    st().commit({ type: 'move', itemId: first.id, start: 5 }, { author: 'you', label: 'One' })
    st().commit({ type: 'move', itemId: first.id, start: 9 }, { author: 'you', label: 'Two' })
    const v1 = st().versions[1]!
    st().restore(v1.id)
    expect(headTimeline(st()).items[first.id]!.start).toBe(5)
    expect(st().versions).toHaveLength(4)
    expect(st().versions[3]!.label).toBe('Restored: One')
  })

  it('applies an AI edit card, tracks its status, and undoes it', () => {
    const plan = fillerPlan()
    st().registerEdit(plan)
    expect(editStatus(st(), plan.id)).toBe('proposed')
    const before = timelineDuration(headTimeline(st()))
    expect(st().previewEdit(plan.id)).toBeNull()
    expect(editStatus(st(), plan.id)).toBe('previewing')
    expect(timelineDuration(shownTimeline(st()))).toBeLessThan(before)
    expect(timelineDuration(headTimeline(st()))).toBe(before)
    expect(st().applyEdit(plan.id).ok).toBe(true)
    expect(editStatus(st(), plan.id)).toBe('applied')
    expect(st().landed.cuts.length).toBeGreaterThan(0)
    expect(st().undoEdit(plan.id).ok).toBe(true)
    expect(editStatus(st(), plan.id)).toBe('undone')
    expect(timelineDuration(headTimeline(st()))).toBeCloseTo(before)
  })

  it('undoes an older AI edit out of order when nothing later overlaps', () => {
    const plan = fillerPlan()
    st().registerEdit(plan)
    st().applyEdit(plan.id)
    const b = trackItems(headTimeline(st()), 'trk_broll')[0]!
    st().commit(
      { type: 'addMarker', marker: { id: 'm1', time: 4, label: 'x' } },
      { author: 'you', label: 'Marker' },
    )
    void b
    const r = st().undoEdit(plan.id)
    expect(r.ok).toBe(true)
    expect(headTimeline(st()).settings.markers).toHaveLength(1)
    expect(editStatus(st(), plan.id)).toBe('undone')
  })

  it('refuses an out-of-order undo that would overwrite later edits', () => {
    const plan = fillerPlan()
    st().registerEdit(plan)
    st().applyEdit(plan.id)
    const v = trackItems(headTimeline(st()), 'trk_video')[0]!
    st().commit(
      { type: 'trim', itemId: v.id, edge: 'end', to: v.start + v.duration - 1 },
      { author: 'you', label: 'Trim' },
    )
    const r = st().undoEdit(plan.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflict).toBe(true)
  })

  it('stays fast after 500 ops on a 300 clip timeline', () => {
    st().reset()
    const big = buildStressTimeline(3600, 300)
    st().open('stress', big, [])
    const ids = trackItems(big, 'trk_video').map((i) => i.id)
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) {
      const id = ids[i % ids.length]!
      const cur = headTimeline(st()).items[id]!
      const r = st().commit(
        { type: 'move', itemId: id, start: cur.start + 0.01 },
        { author: 'you', label: 'nudge' },
      )
      expect(r.ok).toBe(true)
    }
    const ms = performance.now() - t0
    expect(st().versions).toHaveLength(501)
    expect(ms).toBeLessThan(2500)
  })

  it('remembers a project session when it is reopened', () => {
    st().reset()
    st().open('keep-me', timeline, [])
    const first = trackItems(timeline, 'trk_broll')[0]!
    st().commit({ type: 'move', itemId: first.id, start: 7 }, { author: 'you', label: 'Moved' })
    st().reset()
    st().open('keep-me', timeline, [])
    expect(st().versions).toHaveLength(2)
  })
})
