import { memo, useState, type ReactNode } from 'react'
import { CornerDownLeft, Plus, Smartphone } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatDuration, formatRange } from '@/lib/time'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PlaceholderThumb } from './PlaceholderThumb'

function ScoreRing({ score, label }: { score: number; label: string }) {
  const r = 15
  const c = 2 * Math.PI * r
  const color = score >= 80 ? 'var(--saffron)' : score >= 60 ? 'var(--teal)' : 'var(--text-faint)'
  return (
    <span
      role="img"
      aria-label={`${label} ${score} out of 100`}
      className="relative flex size-10 items-center justify-center rounded-full bg-[var(--bg)]/85 backdrop-blur"
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
        />
      </svg>
      <span className="tnum relative text-[12px] font-bold text-text">{score}</span>
    </span>
  )
}

interface ClipCardProps {
  seed: string
  title: string
  start: number
  end: number
  /** 0-100. Shown as a ring on the thumbnail. */
  score?: number
  scoreLabel?: 'Hook score' | 'Relevance'
  /** One-line reason the AI picked this moment. */
  reason?: string
  /** The matched sentence, with the match wrapped in <mark>. Used by search results. */
  matched?: ReactNode
  /** On hover, play a muted preview from this source time. */
  preview?: { src: string; start: number }
  onAdd?: () => void
  onMakeReel?: () => void
  onSend?: () => void
  className?: string
}

export const ClipCard = memo(function ClipCard({
  seed,
  title,
  start,
  end,
  score,
  scoreLabel = 'Hook score',
  reason,
  matched,
  preview,
  onAdd,
  onMakeReel,
  onSend,
  className,
}: ClipCardProps) {
  const [hover, setHover] = useState(false)
  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        'group flex flex-col overflow-hidden rounded-card border border-line bg-surface-1 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-soft',
        className,
      )}
    >
      <PlaceholderThumb seed={seed}>
        {hover && preview && (
          <video
            src={preview.src}
            muted
            autoPlay
            loop
            playsInline
            aria-hidden="true"
            tabIndex={-1}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              v.currentTime = preview.start % (v.duration || 1)
            }}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {score !== undefined && (
          <div className="absolute left-2.5 top-2.5">
            <ScoreRing score={score} label={scoreLabel} />
          </div>
        )}
        <span className="tnum absolute bottom-2.5 right-2.5 rounded-full bg-[var(--bg)]/80 px-2 py-0.5 text-[11px] font-medium text-text backdrop-blur">
          {formatDuration(end - start)}
        </span>
        {/* Hover plays a muted preview; this is the stand-in scrub bar. */}
        <span className="absolute inset-x-0 bottom-0 h-1 bg-transparent">
          <span className="block h-full w-0 bg-saffron group-hover:[animation:preview-bar_4s_linear_infinite]" />
        </span>
      </PlaceholderThumb>

      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-text">{title}</h4>
          <p className="tnum mt-0.5 text-xs text-faint">{formatRange(start, end)}</p>
        </div>

        {matched && (
          <p className="line-clamp-2 text-[13px] leading-relaxed text-muted [&_mark]:rounded [&_mark]:bg-saffron-soft [&_mark]:px-0.5 [&_mark]:text-accent">
            {matched}
          </p>
        )}
        {reason && <p className="text-[13px] leading-snug text-muted">{reason}</p>}

        <div className="mt-auto flex items-center gap-1.5 pt-1.5">
          <Button
            size="sm"
            variant="primary"
            leading={<Plus className="size-3.5" aria-hidden="true" />}
            onClick={onAdd}
          >
            Add to timeline
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leading={<Smartphone className="size-3.5" aria-hidden="true" />}
            onClick={onMakeReel}
          >
            Make a Reel
          </Button>
          <IconButton label="Send to chat" size="sm" className="ml-auto" onClick={onSend}>
            <CornerDownLeft className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </article>
  )
})
