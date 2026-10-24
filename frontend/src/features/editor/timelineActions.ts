import { toast } from '@/components/ui/Toast'
import { uid } from '@/lib/ids'
import { itemEnd, itemsByTrack, trackByKind } from '@lypcut/timeline-core'
import type { Timeline, TimelineItem, TimelineOp } from '@/types'
import { clock } from './clock'
import { headTimeline, useEditor } from './store'

/**
 * Things the timeline toolbar, the keyboard and the context menus all do. Each one turns an
 * intention ("split here") into a TimelineOp and commits it. None of them touch the timeline directly.
 */

const same = (a: number, b: number) => Math.abs(a - b) < 0.02

/** The audio clip that belongs to a video clip: same place, same length, same source. */
export function linkedAudio(tl: Timeline, v: TimelineItem): TimelineItem | undefined {
  if (v.kind !== 'video') return undefined
  const track = trackByKind(tl, 'audio')
  if (!track) return undefined
  return itemsByTrack(tl)[track.id]?.find(
    (a) => same(a.start, v.start) && same(a.duration, v.duration) && same(a.srcIn, v.srcIn),
  )
}

/** Selected ids plus the audio that travels with each selected video clip. */
export function withLinked(tl: Timeline, ids: string[]): string[] {
  const out = new Set(ids)
  for (const id of ids) {
    const it = tl.items[id]
    const a = it && linkedAudio(tl, it)
    if (a) out.add(a.id)
  }
  return [...out]
}

function fail(error: string) {
  toast({ title: "That didn't work", description: error, tone: 'error' })
}

export function commitYou(op: TimelineOp, label: string): boolean {
  const res = useEditor.getState().commit(op, { author: 'you', label })
  if (!res.ok) fail(res.error)
  return res.ok
}

export function splitAtPlayhead() {
  const s = useEditor.getState()
  if (s.preview) return fail('Go back to your edit first. You are looking at a preview.')
  const tl = headTimeline(s)
  const t = clock.time
  const inside = (it: TimelineItem) => t > it.start + 0.1 && t < itemEnd(it) - 0.1
  let targets = s.selection
    .map((id) => tl.items[id])
    .filter((it): it is TimelineItem => !!it && inside(it))
  if (!targets.length) {
    targets = Object.values(tl.items).filter(
      (it) => (it.kind === 'video' || it.kind === 'audio') && inside(it),
    )
  } else {
    targets = withLinked(
      tl,
      targets.map((x) => x.id),
    )
      .map((id) => tl.items[id]!)
      .filter(inside)
  }
  if (!targets.length) return fail('Move the playhead onto a clip to split it.')
  const ops: TimelineOp[] = targets.map((it) => ({
    type: 'split',
    itemId: it.id,
    at: t,
    newId: uid('i'),
  }))
  if (
    commitYou(
      ops.length === 1 ? ops[0]! : { type: 'batch', ops, label: 'Split clip' },
      'Split clip',
    )
  ) {
    s.setSelection([])
  }
}

export function deleteSelection(ripple: boolean) {
  const s = useEditor.getState()
  if (s.preview) return fail('Go back to your edit first. You are looking at a preview.')
  const tl = headTimeline(s)
  const chosen = s.selection.filter((id) => tl.items[id])
  if (!chosen.length) return fail('Click a clip on the timeline first.')
  const ids = withLinked(tl, chosen)
  if (ripple) {
    const vids = ids
      .map((id) => tl.items[id]!)
      .filter((it) => it.kind === 'video' || it.kind === 'audio')
    if (!vids.length) return fail('Ripple delete works on video clips.')
    const from = Math.min(...vids.map((v) => v.start))
    const to = Math.max(...vids.map(itemEnd))
    if (commitYou({ type: 'rippleDelete', from, to }, 'Ripple delete')) s.setSelection([])
    return
  }
  if (
    commitYou(
      { type: 'delete', itemIds: ids },
      ids.length > 1 ? `Deleted ${ids.length} clips` : 'Deleted clip',
    )
  )
    s.setSelection([])
}

export function addMarkerAtPlayhead() {
  const s = useEditor.getState()
  if (s.preview) return
  const tl = headTimeline(s)
  const t = Math.round(clock.time * 10) / 10
  if (tl.settings.markers.some((m) => same(m.time, t))) return
  commitYou(
    {
      type: 'addMarker',
      marker: { id: uid('m'), time: t, label: `Marker ${tl.settings.markers.length + 1}` },
    },
    'Added marker',
  )
}

export function removeMarker(id: string) {
  commitYou({ type: 'removeMarker', id }, 'Removed marker')
}

/** Select the previous or next clip on the video track (keyboard access to the timeline). */
export function selectAdjacent(dir: 1 | -1) {
  const s = useEditor.getState()
  const tl = s.preview?.timeline ?? headTimeline(s)
  const track = trackByKind(tl, 'video')
  const list = track ? (itemsByTrack(tl)[track.id] ?? []) : []
  if (!list.length) return
  const cur = list.findIndex((it) => it.id === s.selection[0])
  const next =
    list[
      Math.min(list.length - 1, Math.max(0, cur < 0 ? (dir > 0 ? 0 : list.length - 1) : cur + dir))
    ]!
  s.setSelection([next.id])
  clock.seek(next.start)
}
