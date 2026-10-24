import { useEffect, useMemo, useRef } from 'react'
import { itemsOfKind } from '@/lib/timeline/queries'
import type { AspectId, Timeline, TimelineItem, Word } from '@/types'
import { clock, useClock } from './clock'
import { LiveCaption } from './CaptionView'
import { aspectRatio, cropAt, cropWindow, videoBox } from './crop'
import { SyncedVideo } from './SyncedVideo'

const EASE = 0.25

/** Zoom effect strength at a moment: 1 when none, easing in and out at the edges. */
function zoomAt(effects: TimelineItem[], t: number): number {
  let m = 1
  for (const e of effects) {
    if (e.meta?.effect !== 'zoom' || t < e.start || t > e.start + e.duration) continue
    const k = Math.min(1, (t - e.start) / EASE, (e.start + e.duration - t) / EASE)
    m = Math.max(m, 1 + ((e.meta.amount ?? 1.3) - 1) * Math.max(0, k))
  }
  return m
}

interface Props {
  timeline: Timeline
  words: Word[]
  videoUrl: string
  aspect?: AspectId
  showSafeZones?: boolean
  syncAs: 'main' | 'mirror'
  className?: string
}

/**
 * The reel as it will export: the 9:16 window of the frame, with captions on top.
 * Crop, keyframes and effects are applied straight to the DOM on every clock frame,
 * so reframing animates smoothly without re-rendering React.
 */
export function ReelScreen({
  timeline,
  words,
  videoUrl,
  aspect,
  showSafeZones,
  syncAs,
  className,
}: Props) {
  const asp = aspect ?? timeline.settings.aspect
  const boxRef = useRef<HTMLDivElement>(null)
  const effects = useMemo(() => itemsOfKind(timeline, 'effect'), [timeline])
  const blurOn = useClock((t) =>
    effects.some((e) => e.meta?.effect === 'blur' && t >= e.start && t <= e.start + e.duration),
  )

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    let last = ''
    const apply = (t: number) => {
      const c = cropAt(timeline.settings, t)
      const win = cropWindow({ ...c, scale: c.scale * zoomAt(effects, t) }, asp)
      const b = videoBox(win)
      const key = `${b.width}|${b.height}|${b.left}|${b.top}`
      if (key === last) return
      last = key
      box.style.width = b.width
      box.style.height = b.height
      box.style.left = b.left
      box.style.top = b.top
    }
    apply(clock.time)
    return clock.onFrame(apply)
  }, [timeline.settings, effects, asp])

  return (
    <div className={`grid size-full place-items-center bg-black ${className ?? ''}`}>
      <div
        className="relative w-full overflow-hidden"
        style={{ aspectRatio: String(aspectRatio(asp)), containerType: 'inline-size' }}
      >
        {blurOn && (
          <div className="absolute inset-0 scale-125">
            <SyncedVideo
              src={videoUrl}
              syncAs="mirror"
              fit="cover"
              className="size-full blur-[14px] brightness-75"
            />
          </div>
        )}
        <div
          ref={boxRef}
          className="absolute"
          style={
            blurOn
              ? {
                  WebkitMaskImage:
                    'radial-gradient(ellipse 52% 62% at 50% 46%, #000 62%, transparent 100%)',
                  maskImage:
                    'radial-gradient(ellipse 52% 62% at 50% 46%, #000 62%, transparent 100%)',
                }
              : undefined
          }
        >
          <SyncedVideo src={videoUrl} syncAs={syncAs} className="size-full" />
        </div>
        <LiveCaption timeline={timeline} words={words} />
        {showSafeZones && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20">
            <div className="absolute inset-x-0 top-0 h-[12%] border-b border-dashed border-teal/70 bg-teal/10" />
            <div className="absolute inset-x-0 bottom-0 h-[18%] border-t border-dashed border-teal/70 bg-teal/10" />
            <div className="absolute bottom-[18%] right-0 top-[40%] w-[16%] border-l border-dashed border-teal/70 bg-teal/10" />
          </div>
        )}
      </div>
    </div>
  )
}
