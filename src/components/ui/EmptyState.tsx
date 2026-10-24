import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** A clip leaps over a cut-line. Reused in every empty state so the motif sticks. */
export function EmptyIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 96"
      fill="none"
      aria-hidden="true"
      className={cn('h-24 w-40 overflow-visible', className)}
    >
      <path
        d="M8 82H152"
        stroke="var(--line-strong)"
        strokeWidth="1.5"
        strokeDasharray="3 6"
        strokeLinecap="round"
      />
      <rect
        x="12"
        y="62"
        width="46"
        height="18"
        rx="9"
        fill="var(--surface-3)"
        stroke="var(--line-strong)"
      />
      <rect
        x="102"
        y="62"
        width="46"
        height="18"
        rx="9"
        fill="var(--saffron-soft)"
        stroke="var(--saffron)"
        strokeOpacity="0.5"
      />
      <path
        d="M80 34V86"
        stroke="var(--coral)"
        strokeWidth="2"
        strokeLinecap="round"
        style={{ filter: 'drop-shadow(0 0 4px var(--coral))' }}
      />
      <g className="leap" style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}>
        <rect
          x="58"
          y="22"
          width="44"
          height="17"
          rx="8.5"
          fill="var(--saffron)"
          transform="rotate(-12 80 30)"
        />
      </g>
      <path
        d="M62 52C66 44 72 40 80 40"
        stroke="var(--text-faint)"
        strokeWidth="1.3"
        strokeDasharray="2 4"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  )
}

interface EmptyStateProps {
  title: string
  description: string
  action?: ReactNode
  size?: 'sm' | 'lg'
  className?: string
}

/** An empty screen is an invitation to act: say what this is, then offer the next step. */
export function EmptyState({
  title,
  description,
  action,
  size = 'lg',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        size === 'lg' ? 'gap-5 px-6 py-14' : 'gap-3 px-4 py-8',
        className,
      )}
    >
      <EmptyIllustration className={size === 'sm' ? 'h-16 w-28' : undefined} />
      <div className="max-w-sm">
        <h3 className={cn('font-semibold text-text', size === 'lg' ? 'text-lg' : 'text-[15px]')}>
          {title}
        </h3>
        <p className="mt-1.5 text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  )
}
