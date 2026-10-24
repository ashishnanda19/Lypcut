import { memo } from 'react'
import { formatTimecode } from '@/lib/time'

interface PlayheadProps {
  /** Horizontal position in pixels inside the lane area. */
  x: number
  /** Seconds, shown in the handle. */
  time: number
  className?: string
}

/**
 * Moves with transform only (no layout), so the 60fps playback clock can drive
 * it without touching the clips underneath. Dragging is wired up by the timeline.
 */
export const Playhead = memo(function Playhead({ x, time, className }: PlayheadProps) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 left-0 z-30 will-change-transform ${className ?? ''}`}
      style={{ transform: `translate3d(${x}px,0,0)` }}
    >
      <span className="tnum absolute left-0 top-1 -translate-x-1/2 rounded-full bg-saffron px-2 py-0.5 text-[11px] font-semibold text-saffron-ink shadow-soft">
        {formatTimecode(time)}
      </span>
      <span className="absolute bottom-0 left-0 top-6 w-0.5 -translate-x-1/2 rounded-full bg-saffron shadow-[0_0_10px_rgb(255_168_58/0.6)]" />
    </div>
  )
})
