import { memo } from 'react'
import { formatDuration } from '@/lib/time'
import { TRACK_HEADER_WIDTH } from './TimelineTrack'

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

interface TimelineRulerProps {
  duration: number
  pxPerSecond: number
}

/**
 * Time ruler. Minor ticks are one repeating gradient (a single element, however long the
 * timeline is); only the labels are real nodes, and only as many as fit.
 */
export const TimelineRuler = memo(function TimelineRuler({
  duration,
  pxPerSecond,
}: TimelineRulerProps) {
  const step = STEPS.find((s) => s * pxPerSecond >= 72) ?? 600
  const labels: number[] = []
  for (let t = 0; t <= duration; t += step) labels.push(t)
  const width = duration * pxPerSecond

  return (
    <div role="presentation" className="flex h-8 border-b border-line">
      <div
        className="sticky left-0 z-20 shrink-0 border-r border-line bg-surface-1"
        style={{ width: TRACK_HEADER_WIDTH }}
      />
      <div
        className="relative shrink-0"
        style={{
          width,
          backgroundImage: `repeating-linear-gradient(90deg, var(--line-strong) 0 1px, transparent 1px ${pxPerSecond}px)`,
          backgroundSize: '100% 6px',
          backgroundRepeat: 'repeat-x',
          backgroundPosition: 'left bottom',
        }}
      >
        {labels.map((t) => (
          <span
            key={t}
            className="tnum absolute top-1.5 text-[11px] text-faint"
            style={{ left: t * pxPerSecond + 5 }}
          >
            {formatDuration(t)}
          </span>
        ))}
      </div>
    </div>
  )
})
