import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  Pause,
  Play,
  Rewind,
  FastForward,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { cn } from '@/lib/cn'
import { formatTimecode } from '@/lib/time'
import { timelineDuration } from '@/lib/timeline/queries'
import type { CropState } from '@/types'
import { clock, useClock } from './clock'
import { clampCrop, cropAt, cropWindow } from './crop'
import { useEditorData } from './data'
import { ReelScreen } from './ReelScreen'
import { SyncedVideo } from './SyncedVideo'
import { headTimeline, shownTimeline, useEditor } from './store'

type View = 'source' | 'reel'

/** The reel window drawn over the full frame. Drag it to reframe the shot. */
function CropBox() {
  const tl = useEditor(shownTimeline)
  const boxRef = useRef<HTMLDivElement>(null)
  const draft = useRef<CropState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const locked = tl.settings.keyframes.length > 0
  const aspect = tl.settings.aspect

  const place = (c: CropState) => {
    const el = boxRef.current
    if (!el) return
    const w = cropWindow(c, aspect)
    el.style.left = `${w.x * 100}%`
    el.style.top = `${w.y * 100}%`
    el.style.width = `${w.w * 100}%`
    el.style.height = `${w.h * 100}%`
  }

  useEffect(() => {
    place(tl.settings.crop)
    if (!locked) return
    return clock.onFrame((t) => place(cropAt(tl.settings, t)))
  })

  const commit = (c: CropState) => {
    useEditor
      .getState()
      .commit({ type: 'setCrop', crop: c }, { author: 'you', label: 'Reframed the shot' })
    draft.current = null
  }

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (locked) return
    const el = boxRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    const rect = parent.getBoundingClientRect()
    const start = {
      x: e.clientX,
      y: e.clientY,
      crop: headTimeline(useEditor.getState()).settings.crop,
    }
    const move = (ev: globalThis.PointerEvent) => {
      const next = clampCrop(
        {
          ...start.crop,
          x: start.crop.x + (ev.clientX - start.x) / rect.width,
          y: start.crop.y + (ev.clientY - start.y) / rect.height,
        },
        aspect,
      )
      draft.current = next
      place(next)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (draft.current) commit(draft.current)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return
    const step = e.shiftKey ? 0.1 : 0.02
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    if (!dx && !dy) return
    e.preventDefault()
    const base = draft.current ?? headTimeline(useEditor.getState()).settings.crop
    const next = clampCrop({ ...base, x: base.x + dx, y: base.y + dy }, aspect)
    draft.current = next
    place(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => draft.current && commit(draft.current), 450)
  }

  return (
    // A custom drag-and-arrow-key control, so it carries handlers and a tab stop on purpose.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={boxRef}
      role="group"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={
        locked
          ? 'Reel window, animated by keyframes'
          : 'Reel window. Drag, or use the arrow keys, to reframe the shot.'
      }
      onPointerDown={onDown}
      onKeyDown={onKey}
      className={cn(
        'absolute z-10 rounded-md border-2 border-saffron shadow-[0_0_0_9999px_rgb(0_0_0/0.5)] outline-offset-2',
        locked ? 'cursor-default' : 'cursor-grab touch-none active:cursor-grabbing',
      )}
    >
      <span className="absolute left-1.5 top-1.5 whitespace-nowrap rounded-full bg-saffron px-2 py-0.5 text-[11px] font-semibold text-saffron-ink">
        {tl.settings.aspect} reel window
      </span>
    </div>
  )
}

function Scrubber() {
  const ref = useRef<HTMLInputElement>(null)
  const dragging = useRef(false)
  const tl = useEditor(shownTimeline)
  const dur = timelineDuration(tl)
  const whole = useClock((t) => Math.floor(t))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.value = String(clock.time)
    return clock.onFrame((t) => {
      if (!dragging.current) el.value = String(t)
      el.style.setProperty('--pct', `${dur ? (t / dur) * 100 : 0}%`)
    })
  }, [dur])

  return (
    <input
      ref={ref}
      type="range"
      min={0}
      max={Math.max(dur, 0.1)}
      step={0.05}
      aria-label="Seek"
      aria-valuetext={`${whole} seconds of ${Math.round(dur)}`}
      onPointerDown={() => (dragging.current = true)}
      onPointerUp={() => (dragging.current = false)}
      onChange={(e) => clock.seek(Number(e.target.value))}
      className="h-5 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-saffron [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--saffron)_var(--pct,0%),var(--surface-3)_var(--pct,0%))] [&::-webkit-slider-thumb]:-mt-[4px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-saffron"
    />
  )
}

function Timecode() {
  const label = useClock((t) => formatTimecode(t))
  const tl = useEditor(shownTimeline)
  return (
    <span className="tnum text-sm font-medium text-text">
      {label} <span className="text-faint">/ {formatTimecode(timelineDuration(tl))}</span>
    </span>
  )
}

export function Transport({ compact }: { compact?: boolean }) {
  const playing = useClock((_, p) => p)
  const muted = useEditor((s) => s.muted)
  const setMuted = useEditor((s) => s.setMuted)
  const [rate, setRate] = useState(1)
  return (
    <div className="flex flex-col gap-2">
      <Scrubber />
      <div className="flex items-center gap-1.5">
        {!compact && (
          <IconButton
            label="Back 5 seconds"
            shortcut={['Shift', '←']}
            onClick={() => clock.seek(clock.time - 5)}
          >
            <Rewind className="size-4" aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="Start" onClick={() => clock.seek(0)}>
          <SkipBack className="size-4" aria-hidden="true" />
        </IconButton>
        <IconButton
          label={playing ? 'Pause' : 'Play'}
          shortcut={['Space']}
          variant="primary"
          size="lg"
          onClick={() => clock.toggle()}
        >
          {playing ? (
            <Pause className="size-5" aria-hidden="true" />
          ) : (
            <Play className="size-5 translate-x-px" aria-hidden="true" />
          )}
        </IconButton>
        <IconButton label="End" onClick={() => clock.seek(clock.duration)}>
          <SkipForward className="size-4" aria-hidden="true" />
        </IconButton>
        {!compact && (
          <IconButton
            label="Forward 5 seconds"
            shortcut={['Shift', '→']}
            onClick={() => clock.seek(clock.time + 5)}
          >
            <FastForward className="size-4" aria-hidden="true" />
          </IconButton>
        )}
        <div className="ml-2 min-w-0 flex-1">
          <Timecode />
        </div>
        <button
          type="button"
          aria-label={`Playback speed ${rate} times. Change`}
          onClick={() => {
            const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : rate === 2 ? 0.5 : 1
            setRate(next)
            clock.rate = next
          }}
          className="tnum h-8 rounded-full px-2.5 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-text"
        >
          {rate}x
        </button>
        <IconButton
          label={muted ? 'Unmute' : 'Mute'}
          shortcut={['Shift', 'M']}
          onClick={() => setMuted(!muted)}
        >
          {muted ? (
            <VolumeX className="size-4" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4" aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </div>
  )
}

/** Banner shown while a preview (an Edit card, or an old version) is on screen instead of your edit. */
export function PreviewBanner() {
  const preview = useEditor((s) => s.preview)
  const label = useEditor((s) => {
    if (!s.preview) return ''
    if (s.preview.kind === 'edit') return s.edits[s.preview.id]?.plan.title ?? 'edit'
    return [...s.versions, ...s.archived].find((v) => v.id === s.preview!.id)?.label ?? 'version'
  })
  if (!preview) return null
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-full bg-teal-soft px-4 py-1.5 text-[13px] text-teal-text"
    >
      <span className="size-2 animate-pulse rounded-full bg-teal" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        Previewing: <strong className="font-semibold">{label}</strong>. Your edit is unchanged.
      </span>
      <button
        type="button"
        className="shrink-0 font-semibold underline underline-offset-2"
        onClick={() => useEditor.getState().previewEdit(null)}
      >
        Back to my edit
      </button>
    </div>
  )
}

/** Centre column: the main player, with a Source / Reel switch and the transport. */
export function PlayerPanel() {
  const { videoUrl, transcript } = useEditorData()
  const tl = useEditor(shownTimeline)
  const [view, setView] = useState<View>('source')

  return (
    <section aria-label="Player" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList label="Player view">
            <TabsTrigger value="source">Source</TabsTrigger>
            <TabsTrigger value="reel">Reel 9:16</TabsTrigger>
          </TabsList>
        </Tabs>
        <PreviewBanner />
      </div>

      <div className="min-h-0 flex-1 [container-type:size]">
        <div className="grid size-full place-items-center">
          {view === 'source' ? (
            <div
              className="relative overflow-hidden rounded-card bg-black"
              style={{ width: 'min(100cqw, calc(100cqh * 1.7778))', aspectRatio: '16 / 9' }}
            >
              <div className="absolute inset-0 overflow-hidden rounded-card">
                <SyncedVideo src={videoUrl} syncAs="main" className="size-full" />
              </div>
              <CropBox />
            </div>
          ) : (
            <div
              className="overflow-hidden rounded-card"
              style={{ height: '100cqh', aspectRatio: '9 / 16', maxWidth: '100cqw' }}
            >
              <ReelScreen
                timeline={tl}
                words={transcript.words}
                videoUrl={videoUrl}
                syncAs="main"
              />
            </div>
          )}
        </div>
      </div>

      <Transport />
    </section>
  )
}
