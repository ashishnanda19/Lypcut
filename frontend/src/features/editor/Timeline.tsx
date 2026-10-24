import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as RPointerEvent,
} from 'react'
import {
  Captions,
  Film,
  Flag,
  Layers,
  Magnet,
  Mic,
  Minus,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  X,
  ChevronsLeftRight,
} from 'lucide-react'
import { TimelineClip, type ClipKind } from '@/components/domain/TimelineClip'
import { TimelineRuler } from '@/components/domain/TimelineRuler'
import { TimelineTrack, TRACK_HEADER_WIDTH } from '@/components/domain/TimelineTrack'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'
import { formatTimecode } from '@/lib/time'
import { diffTimelines, itemEnd, itemsByTrack, timelineDuration } from '@/lib/timeline/queries'
import { usePrefs } from '@/stores/prefs'
import type { Timeline, TimelineItem, TimelineOp, Track } from '@/types'
import { clock } from './clock'
import {
  addMarkerAtPlayhead,
  commitYou,
  deleteSelection,
  linkedAudio,
  removeMarker,
  selectAdjacent,
  splitAtPlayhead,
  withLinked,
} from './timelineActions'
import { headTimeline, shownTimeline, useEditor } from './store'
import { toast } from '@/components/ui/Toast'

const ROW: Record<Track['kind'], number> = {
  video: 58,
  broll: 46,
  audio: 50,
  captions: 42,
  effects: 42,
}
const ICON: Record<Track['kind'], typeof Film> = {
  video: Film,
  broll: Layers,
  audio: Mic,
  captions: Captions,
  effects: Sparkles,
}
const CLIP_KIND: Record<TimelineItem['kind'], ClipKind> = {
  video: 'video',
  broll: 'broll',
  audio: 'audio',
  caption: 'caption',
  effect: 'effect',
}
const MIN_PX = 1.5
const MAX_PX = 260
const SNAP_PX = 9
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** First index whose end is at or after `t`. Items on a lane are sorted and do not overlap. */
function lowerBound(arr: TimelineItem[], t: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (itemEnd(arr[mid]!) < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

type DragMode = 'move' | 'trim-start' | 'trim-end'
interface Drag {
  mode: DragMode
  ids: string[]
  /** Pointer offset from where it started, in seconds, after snapping. */
  dt: number
  trackId?: string
  invalid: boolean
}

interface FxState {
  key: number
  leap: Set<string>
  slide: Set<string>
  cuts: number[]
}

/** The one clip as drawn on a lane. Memoised, so only clips whose props change repaint. */
const Clip = memo(function Clip(props: {
  item: TimelineItem
  px: number
  selected: boolean
  fx?: 'leap' | 'slide'
  cutAt?: number
  fine: boolean
  offset: number
  trimStart: number
  trimEnd: number
  invalid: boolean
  diff?: 'added' | 'changed'
  dev: boolean
}) {
  const { item, px, selected, fx, cutAt, fine, offset, trimStart, trimEnd, invalid, diff, dev } =
    props
  const start = item.start + offset + trimStart
  const dur = item.duration - trimStart + trimEnd
  const label =
    item.kind === 'caption' ? ((dev ? item.meta?.dev : item.meta?.text) ?? item.label) : item.label
  return (
    <TimelineClip
      data-clip-id={item.id}
      kind={CLIP_KIND[item.kind]}
      label={label}
      left={start * px}
      width={dur * px}
      selected={selected}
      landed={fx}
      cutAt={cutAt}
      fineHandles={fine}
      height={item.kind === 'video' ? 50 : item.kind === 'audio' ? 42 : 34}
      className={cn(
        offset !== 0 && 'cursor-grabbing opacity-90',
        invalid && 'border-danger !bg-danger-soft ring-2 ring-danger',
        diff === 'added' && 'ring-2 ring-teal ring-offset-1 ring-offset-[var(--surface-1)]',
        diff === 'changed' && 'ring-2 ring-dashed ring-saffron',
      )}
    />
  )
})

export function TimelineView({
  advanced,
  onShortcuts,
}: {
  advanced: boolean
  onShortcuts: () => void
}) {
  const tl = useEditor(shownTimeline)
  const preview = useEditor((s) => s.preview)
  const compare = useEditor((s) => s.compare)
  const selection = useEditor((s) => s.selection)
  const landed = useEditor((s) => s.landed)
  const muted = useEditor((s) => s.muted)
  const setMuted = useEditor((s) => s.setMuted)
  const snap = usePrefs((s) => s.snap)
  const setSnap = usePrefs((s) => s.setSnap)
  const dev = usePrefs((s) => s.captionDev)
  const readOnly = !!preview

  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const [view, setView] = useState({ w: 900, left: 0 })
  const [zoom, setZoom] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [fx, setFx] = useState<FxState | null>(null)

  const duration = timelineDuration(tl)
  const fit = clamp((view.w - TRACK_HEADER_WIDTH - 36) / Math.max(duration, 1), MIN_PX, MAX_PX)
  const px = zoom ?? fit
  const laneW = Math.max(duration * px + 160, view.w - TRACK_HEADER_WIDTH)

  /* ---- viewport (resize and scroll) ---- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setView((v) => (v.w === el.clientWidth ? v : { ...v, w: el.clientWidth }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // Quantised, so scrolling a few pixels does not re-render the lanes.
        const step = Math.max(120, el.clientWidth / 3)
        const left = Math.floor(el.scrollLeft / step) * step
        setView((v) => (v.left === left ? v : { ...v, left }))
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [])

  const winFrom = Math.max(0, (view.left - view.w) / px)
  const winTo = (view.left + view.w * 2.4) / px

  /* ---- playhead: moved straight in the DOM, never through React ---- */
  useEffect(() => {
    const head = headRef.current
    const label = labelRef.current
    const sc = scrollRef.current
    if (!head || !label || !sc) return
    let lastLabel = ''
    const update = (t: number, playing: boolean) => {
      const x = t * px
      head.style.transform = `translate3d(${x}px,0,0)`
      const text = formatTimecode(t)
      if (text !== lastLabel) {
        lastLabel = text
        label.textContent = text
      }
      if (playing) {
        const rel = x - sc.scrollLeft
        if (rel > sc.clientWidth - TRACK_HEADER_WIDTH - 60 || rel < 0)
          sc.scrollLeft = Math.max(0, x - 120)
      }
    }
    update(clock.time, false)
    return clock.onFrame(update)
  }, [px])

  /* ---- zoom helpers ---- */
  const setZoomAround = useCallback(
    (next: number) => {
      const sc = scrollRef.current
      const centre = sc ? (sc.scrollLeft + sc.clientWidth / 2) / px : 0
      const z = clamp(next, MIN_PX, MAX_PX)
      setZoom(z)
      requestAnimationFrame(() => sc && (sc.scrollLeft = centre * z - sc.clientWidth / 2))
    },
    [px],
  )

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoomAround(px * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    sc.addEventListener('wheel', wheel, { passive: false })
    return () => sc.removeEventListener('wheel', wheel)
  }, [px, setZoomAround])

  useEffect(() => {
    const on = (e: Event) => setZoomAround(px * ((e as CustomEvent<number>).detail ?? 1))
    window.addEventListener('lypcut:zoom', on)
    return () => window.removeEventListener('lypcut:zoom', on)
  }, [px, setZoomAround])

  /* ---- landing animation for AI edits ---- */
  useEffect(() => {
    if (!landed.key) return
    const leap = new Set([...landed.added, ...landed.changed].slice(0, 80))
    const slide = new Set(landed.moved.slice(0, 80))
    // A short-lived reaction to an edit landing in the store, cleared by the timeout below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFx({ key: landed.key, leap, slide, cuts: landed.cuts })
    const id = setTimeout(() => setFx((f) => (f?.key === landed.key ? null : f)), 900)
    return () => clearTimeout(id)
  }, [landed])

  /* ---- rows and visible clips ---- */
  const byTrack = useMemo(() => itemsByTrack(tl), [tl])
  const rows = tl.tracks.filter((t) => !t.advanced || advanced || (byTrack[t.id]?.length ?? 0) > 0)
  const diff = useMemo(() => {
    if (!preview || !compare || preview.kind !== 'version') return null
    const head = headTimeline(useEditor.getState())
    return { ...diffTimelines(head, preview.timeline), head }
  }, [preview, compare])

  const secOf = (clientX: number) => {
    const sc = scrollRef.current!
    return Math.max(
      0,
      (clientX - sc.getBoundingClientRect().left + sc.scrollLeft - TRACK_HEADER_WIDTH) / px,
    )
  }

  /* ---- snapping: edges of every clip, markers and the playhead ---- */
  const edgesRef = useRef<number[]>([])
  const buildEdges = (skip: Set<string>) => {
    const e: number[] = [0, clock.time, ...tl.settings.markers.map((m) => m.time)]
    for (const it of Object.values(tl.items)) {
      if (skip.has(it.id)) continue
      e.push(it.start, itemEnd(it))
    }
    edgesRef.current = e.sort((a, b) => a - b)
  }
  const snapTo = (t: number, alsoEnd = 0): number => {
    if (!snap) return t
    const e = edgesRef.current
    const thr = SNAP_PX / px
    let best = t
    let bd = thr
    for (const cand of [t, t + alsoEnd]) {
      let lo = 0
      let hi = e.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (e[mid]! < cand) lo = mid + 1
        else hi = mid
      }
      for (const j of [lo - 1, lo]) {
        const v = e[j]
        if (v === undefined) continue
        const d = Math.abs(v - cand)
        if (d < bd) {
          bd = d
          best = t + (v - cand)
        }
      }
    }
    return Math.max(0, best)
  }

  /* ---- pointer: select, scrub, move, trim ---- */
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-marker]')) return
    const clipEl = target.closest<HTMLElement>('[data-clip-id]')
    const sc = scrollRef.current!
    sc.focus({ preventScroll: true })

    if (!clipEl) {
      // Empty lane or the ruler: scrub the playhead, and clear the selection.
      const scrub = (ev: PointerEvent | RPointerEvent) => clock.seek(secOf(ev.clientX))
      scrub(e)
      if (target.closest('[data-lane]')) useEditor.getState().setSelection([])
      sc.setPointerCapture(e.pointerId)
      const up = () => {
        sc.removeEventListener('pointermove', scrub)
        sc.removeEventListener('pointerup', up)
      }
      sc.addEventListener('pointermove', scrub)
      sc.addEventListener('pointerup', up)
      return
    }

    const id = clipEl.dataset.clipId!
    const item = tl.items[id]
    if (!item) return
    const store = useEditor.getState()
    let sel = store.selection
    if (e.shiftKey || e.metaKey || e.ctrlKey)
      sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
    else if (!sel.includes(id)) sel = [id]
    store.setSelection(sel)
    if (readOnly || !sel.includes(id)) return

    const edge = target.dataset.edge
    const mode: DragMode = edge === 'start' ? 'trim-start' : edge === 'end' ? 'trim-end' : 'move'
    const ids = mode === 'move' ? withLinked(tl, sel) : withLinked(tl, [id])
    const skip = new Set(ids)
    buildEdges(skip)
    const startX = e.clientX
    const startT = secOf(e.clientX)
    let moved = false
    let last: Drag = { mode, ids, dt: 0, invalid: false }

    const rowAt = (clientY: number) =>
      document
        .elementsFromPoint(sc.getBoundingClientRect().left + TRACK_HEADER_WIDTH + 20, clientY)
        .find((n) => (n as HTMLElement).dataset?.trackId) as HTMLElement | undefined

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return
      moved = true
      let dt = secOf(ev.clientX) - startT
      let trackId: string | undefined
      if (mode === 'move') {
        const base = tl.items[id]!
        dt = Math.max(dt, -Math.min(...ids.map((i) => tl.items[i]!.start)))
        dt = snapTo(base.start + dt, base.duration) - base.start
        if ((ids.length === 2 && linkedAudio(tl, base)) || ids.length === 1) {
          const row = rowAt(ev.clientY)?.dataset.trackId
          if (row && row !== base.trackId) trackId = row
        }
      } else if (mode === 'trim-start') {
        dt = snapTo(item.start + dt) - item.start
      } else {
        dt = snapTo(itemEnd(item) + dt) - itemEnd(item)
      }
      const invalid = overlaps(tl, ids, mode, dt, trackId)
      last = { mode, ids, dt, trackId, invalid }
      setDrag(last)
    }
    const up = () => {
      sc.removeEventListener('pointermove', move)
      sc.removeEventListener('pointerup', up)
      sc.removeEventListener('pointercancel', up)
      setDrag(null)
      if (!moved) {
        // A click, not a drag: put the playhead there.
        if (!(e.shiftKey || e.metaKey || e.ctrlKey)) clock.seek(secOf(e.clientX))
        return
      }
      if (last.dt === 0 && !last.trackId) return
      if (last.invalid) {
        toast({
          title: "Clips can't overlap",
          description: 'Drop it in a free spot on the track.',
          tone: 'error',
        })
        return
      }
      commitDrag(tl, last)
    }
    sc.setPointerCapture(e.pointerId)
    sc.addEventListener('pointermove', move)
    sc.addEventListener('pointerup', up)
    sc.addEventListener('pointercancel', up)
  }

  /* ---- keyboard on the timeline itself ---- */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      selectAdjacent(-1)
    } else if (e.key === 'ArrowRight' && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      selectAdjacent(1)
    }
  }

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const fine = advanced

  const addedSet = useMemo(() => new Set(diff?.added ?? []), [diff])
  const changedSet = useMemo(() => new Set(diff?.changed ?? []), [diff])

  return (
    <section
      aria-label="Timeline"
      className="flex h-full min-h-0 flex-col rounded-card border border-line bg-surface-1"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <IconButton
          label="Split at playhead"
          shortcut={['S']}
          onClick={splitAtPlayhead}
          disabled={readOnly}
        >
          <Scissors className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Delete"
          shortcut={['Delete']}
          onClick={() => deleteSelection(false)}
          disabled={readOnly || !selection.length}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </IconButton>
        <Tooltip content="Ripple delete: remove and close the gap" shortcut={['Shift', 'Delete']}>
          <button
            type="button"
            onClick={() => deleteSelection(true)}
            disabled={readOnly || !selection.length}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-45"
          >
            <ChevronsLeftRight className="size-4" aria-hidden="true" />
            Ripple delete
          </button>
        </Tooltip>
        <IconButton
          label="Add marker"
          shortcut={['M']}
          onClick={addMarkerAtPlayhead}
          disabled={readOnly}
        >
          <Flag className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={snap ? 'Snapping on' : 'Snapping off'}
          variant={snap ? 'active' : 'ghost'}
          onClick={() => setSnap(!snap)}
          aria-pressed={snap}
        >
          <Magnet className="size-4" aria-hidden="true" />
        </IconButton>
        <div className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />
        {diff && (
          <span
            role="status"
            className="tnum rounded-full bg-teal-soft px-3 py-1 text-xs font-medium text-teal-text"
          >
            {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length}{' '}
            removed
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onShortcuts}
            className="hidden rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text sm:block"
          >
            Shortcuts <kbd className="ml-1 rounded border border-line px-1">?</kbd>
          </button>
          <IconButton
            label="Zoom out"
            shortcut={['-']}
            size="sm"
            onClick={() => setZoomAround(px / 1.3)}
          >
            <Minus className="size-4" aria-hidden="true" />
          </IconButton>
          <label className="sr-only" htmlFor="tl-zoom">
            Timeline zoom
          </label>
          <input
            id="tl-zoom"
            type="range"
            min={Math.log(MIN_PX)}
            max={Math.log(MAX_PX)}
            step={0.01}
            value={Math.log(px)}
            onChange={(e) => setZoomAround(Math.exp(Number(e.target.value)))}
            className="h-1 w-24 cursor-pointer accent-[var(--saffron)]"
          />
          <IconButton
            label="Zoom in"
            shortcut={['+']}
            size="sm"
            onClick={() => setZoomAround(px * 1.3)}
          >
            <Plus className="size-4" aria-hidden="true" />
          </IconButton>
          <button
            type="button"
            onClick={() => setZoom(null)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium',
              zoom === null ? 'text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
            )}
          >
            Fit
          </button>
        </div>
      </div>

      {/* Tracks */}
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label="Timeline tracks. Use left and right arrows to select clips."
        aria-rowcount={rows.length}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="scroll-thin relative min-h-0 flex-1 touch-pan-y select-none overflow-x-auto overflow-y-auto outline-offset-[-2px]"
      >
        <div className="relative" style={{ width: TRACK_HEADER_WIDTH + laneW }}>
          <div className="sticky top-0 z-30 bg-surface-1">
            <TimelineRuler duration={laneW / px} pxPerSecond={px} />
            <div
              className="pointer-events-none absolute inset-y-0 left-0"
              style={{ left: TRACK_HEADER_WIDTH }}
            >
              {tl.settings.markers.map((m) => (
                <div
                  key={m.id}
                  data-marker
                  className="group/marker pointer-events-auto absolute top-0 -translate-x-1/2"
                  style={{ left: m.time * px }}
                >
                  <button
                    type="button"
                    aria-label={`Marker ${m.label} at ${formatTimecode(m.time)}. Go there.`}
                    onClick={() => clock.seek(m.time)}
                    className="flex flex-col items-center"
                  >
                    <Flag className="size-3.5 fill-coral text-coral" aria-hidden="true" />
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${m.label}`}
                      onClick={() => removeMarker(m.id)}
                      className="absolute -right-3 -top-1 hidden size-4 items-center justify-center rounded-full bg-surface-3 text-faint hover:text-text group-focus-within/marker:flex group-hover/marker:flex"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {rows.map((track) => {
            const arr = byTrack[track.id] ?? []
            const from = lowerBound(arr, winFrom)
            const visible: TimelineItem[] = []
            for (let i = from; i < arr.length && arr[i]!.start <= winTo; i++) visible.push(arr[i]!)
            const Icon = ICON[track.kind]
            return (
              <TimelineTrack
                key={track.id}
                label={track.name}
                icon={<Icon className="size-4" />}
                laneWidth={laneW}
                height={ROW[track.kind]}
                muted={track.kind === 'audio' ? muted : undefined}
                onToggleMute={track.kind === 'audio' ? () => setMuted(!muted) : undefined}
                locked={track.locked}
                trackId={track.id}
              >
                {visible.map((it) => {
                  const dr = drag?.ids.includes(it.id) ? drag : null
                  const cut = fx?.cuts.find((c) => c >= it.start && c <= itemEnd(it))
                  return (
                    <Clip
                      key={it.id}
                      item={it}
                      px={px}
                      selected={selectedSet.has(it.id)}
                      fx={fx?.leap.has(it.id) ? 'leap' : fx?.slide.has(it.id) ? 'slide' : undefined}
                      cutAt={
                        cut !== undefined && (fx?.leap.has(it.id) || fx?.slide.has(it.id))
                          ? (cut - it.start) * px
                          : undefined
                      }
                      fine={fine}
                      offset={dr?.mode === 'move' ? dr.dt : 0}
                      trimStart={dr?.mode === 'trim-start' ? dr.dt : 0}
                      trimEnd={dr?.mode === 'trim-end' ? dr.dt : 0}
                      invalid={!!dr?.invalid}
                      diff={
                        addedSet.has(it.id)
                          ? 'added'
                          : changedSet.has(it.id)
                            ? 'changed'
                            : undefined
                      }
                      dev={dev}
                    />
                  )
                })}
              </TimelineTrack>
            )
          })}

          {/* Playhead */}
          <div
            className="pointer-events-none absolute inset-y-0 z-40"
            style={{ left: TRACK_HEADER_WIDTH, width: laneW }}
          >
            <div
              ref={headRef}
              aria-hidden="true"
              className="absolute inset-y-0 left-0 will-change-transform"
            >
              <span
                ref={labelRef}
                className="tnum absolute left-0 top-1 -translate-x-1/2 rounded-full bg-saffron px-2 py-0.5 text-[11px] font-semibold text-saffron-ink shadow-soft"
              />
              <span className="absolute bottom-0 left-0 top-6 w-0.5 -translate-x-1/2 rounded-full bg-saffron shadow-[0_0_10px_rgb(255_168_58/0.6)]" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------------- drag maths ---------------- */

/** Would this drag put two clips on top of each other? Cheap: only looks at the same lane. */
function overlaps(
  tl: Timeline,
  ids: string[],
  mode: DragMode,
  dt: number,
  trackId?: string,
): boolean {
  const byTrack = itemsByTrack(tl)
  const moving = new Set(ids)
  for (const id of ids) {
    const it = tl.items[id]!
    let s = it.start
    let e = itemEnd(it)
    if (mode === 'move') {
      s += dt
      e += dt
    } else if (mode === 'trim-start') s += dt
    else e += dt
    if (s < -1e-6 || e - s < 0.1) return true
    const lane = byTrack[trackId ?? it.trackId] ?? []
    const i = lowerBound(lane, s)
    for (let j = Math.max(0, i - 1); j < lane.length && lane[j]!.start < e; j++) {
      const o = lane[j]!
      if (moving.has(o.id)) continue
      if (s < itemEnd(o) - 1e-3 && e > o.start + 1e-3) return true
    }
  }
  return false
}

function commitDrag(tl: Timeline, d: Drag) {
  const ops: TimelineOp[] = []
  for (const id of d.ids) {
    const it = tl.items[id]!
    if (d.mode === 'move')
      ops.push({
        type: 'move',
        itemId: id,
        start: it.start + d.dt,
        ...(d.trackId && d.ids.length <= 2 && it.kind !== 'audio' ? { trackId: d.trackId } : {}),
      })
    else if (d.mode === 'trim-start')
      ops.push({ type: 'trim', itemId: id, edge: 'start', to: it.start + d.dt })
    else ops.push({ type: 'trim', itemId: id, edge: 'end', to: itemEnd(it) + d.dt })
  }
  const label =
    d.mode === 'move'
      ? d.ids.length > 2
        ? `Moved ${d.ids.length} clips`
        : 'Moved clip'
      : 'Trimmed clip'
  commitYou(ops.length === 1 ? ops[0]! : { type: 'batch', ops, label }, label)
}
