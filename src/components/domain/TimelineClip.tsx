import { memo, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { CutLine } from '@/components/brand/CutLine'
import { Waveform } from './Waveform'

export type ClipKind = 'video' | 'broll' | 'audio' | 'caption' | 'effect'

const kindStyle: Record<ClipKind, string> = {
  video: 'border-saffron/55 bg-saffron-soft text-accent',
  broll: 'border-teal/55 bg-teal-soft text-teal-text',
  audio: 'border-line-strong bg-surface-3 text-teal-text',
  caption: 'border-line-strong bg-surface-3 text-text',
  effect: 'border-dashed border-faint bg-surface-2 text-muted',
}

interface TimelineClipProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  kind: ClipKind
  label: string
  /** Position and size in pixels, already scaled by the timeline zoom. */
  left: number
  width: number
  selected?: boolean
  /** Set when an AI edit just placed this clip. "leap" arcs in; "slide" slides in. */
  landed?: 'leap' | 'slide'
  /** Pixel offset inside the clip where a cut just happened. Plays the cut-line flash. */
  cutAt?: number
  /** Show wider trim handles (Advanced mode). */
  fineHandles?: boolean
  height?: number
}

/**
 * Positioned with absolute left/width and nothing else, so hundreds of these
 * stay cheap. Dragging and trimming are handled by the timeline through
 * delegated pointer events that read data-clip-id and data-edge.
 */
export const TimelineClip = memo(function TimelineClip({
  kind,
  label,
  left,
  width,
  selected,
  landed,
  cutAt,
  fineHandles,
  height = 44,
  className,
  style,
  ...props
}: TimelineClipProps) {
  const showWave = kind === 'audio' || kind === 'video'
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={`${label} clip`}
      aria-pressed={selected}
      className={cn(
        'group/clip absolute top-1 flex select-none overflow-hidden rounded-[10px] border text-xs font-medium',
        kind === 'audio' ? 'items-start pt-1' : 'items-center',
        kindStyle[kind],
        selected && 'z-10 ring-2 ring-saffron ring-offset-1 ring-offset-[var(--surface-1)]',
        landed === 'leap' && 'leap landed-glow',
        landed === 'slide' && 'animate-slide-in landed-glow',
        className,
      )}
      style={{ left, width: Math.max(width, 6), height, ...style }}
      {...props}
    >
      {kind === 'video' && (
        <span
          aria-hidden="true"
          className="absolute inset-0 opacity-60 [background-image:repeating-linear-gradient(90deg,transparent_0_61px,color-mix(in_srgb,var(--text)_10%,transparent)_61px_62px)]"
        />
      )}
      {showWave && width > 24 && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0.5 opacity-45">
          <Waveform
            seed={label}
            width={Math.floor(width)}
            height={kind === 'audio' ? height - 20 : 16}
          />
        </span>
      )}
      {width > 48 && <span className="relative truncate px-2.5">{label}</span>}

      <span
        data-edge="start"
        className={cn(
          'absolute inset-y-0 left-0 cursor-ew-resize rounded-l-[10px] bg-current opacity-0 transition-opacity group-hover/clip:opacity-35',
          fineHandles ? 'w-2.5' : 'w-1.5',
        )}
      />
      <span
        data-edge="end"
        className={cn(
          'absolute inset-y-0 right-0 cursor-ew-resize rounded-r-[10px] bg-current opacity-0 transition-opacity group-hover/clip:opacity-35',
          fineHandles ? 'w-2.5' : 'w-1.5',
        )}
      />

      {cutAt !== undefined && (
        <span className="pointer-events-none absolute inset-y-0" style={{ left: cutAt }}>
          <CutLine flash className="-translate-x-1/2" />
        </span>
      )}
    </div>
  )
})
