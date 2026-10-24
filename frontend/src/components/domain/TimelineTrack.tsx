import type { ReactNode } from 'react'
import { Lock, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui/IconButton'

interface TimelineTrackProps {
  label: string
  icon?: ReactNode
  /** Total lane width in pixels (duration x zoom). */
  laneWidth: number
  height?: number
  muted?: boolean
  locked?: boolean
  onToggleMute?: () => void
  /** Lets the timeline find which lane the pointer is over while dragging. */
  trackId?: string
  /** Clips, absolutely positioned inside the lane. */
  children?: ReactNode
  className?: string
}

export const TRACK_HEADER_WIDTH = 132

export function TimelineTrack({
  label,
  icon,
  laneWidth,
  height = 52,
  muted,
  locked,
  onToggleMute,
  trackId,
  children,
  className,
}: TimelineTrackProps) {
  return (
    <div
      role="row"
      aria-label={`${label} track`}
      className={cn('flex', className)}
      style={{ height }}
    >
      <div
        className="sticky left-0 z-20 flex shrink-0 items-center gap-1.5 border-r border-line bg-surface-1 pl-3 pr-1.5"
        style={{ width: TRACK_HEADER_WIDTH }}
      >
        <span className="text-faint" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">{label}</span>
        {locked ? (
          <Lock className="mr-1.5 size-3.5 text-faint" aria-label="Locked" />
        ) : (
          onToggleMute && (
            <IconButton
              label={muted ? `Unmute ${label}` : `Mute ${label}`}
              size="sm"
              variant={muted ? 'active' : 'ghost'}
              onClick={onToggleMute}
              className="size-7"
            >
              {muted ? (
                <VolumeX className="size-3.5" aria-hidden="true" />
              ) : (
                <Volume2 className="size-3.5" aria-hidden="true" />
              )}
            </IconButton>
          )
        )}
      </div>
      <div
        role="gridcell"
        data-lane
        data-track-id={trackId}
        className={cn(
          'relative shrink-0 border-b border-line/70 bg-[color-mix(in_srgb,var(--surface-2)_55%,transparent)]',
          muted && 'opacity-50',
        )}
        style={{ width: laneWidth }}
      >
        {children}
      </div>
    </div>
  )
}
