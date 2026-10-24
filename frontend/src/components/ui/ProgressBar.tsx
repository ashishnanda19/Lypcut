import * as RProgress from '@radix-ui/react-progress'
import { cn } from '@/lib/cn'

interface ProgressBarProps {
  /** 0 to 100. Omit or pass null for an indeterminate bar. */
  value?: number | null
  label: string
  size?: 'sm' | 'md'
  tone?: 'saffron' | 'teal'
  className?: string
}

/** The fill ends in a small cut-line, so progress reads as "the cut moves forward". */
export function ProgressBar({
  value = null,
  label,
  size = 'md',
  tone = 'saffron',
  className,
}: ProgressBarProps) {
  const indeterminate = value === null
  const pct = indeterminate ? 0 : Math.min(100, Math.max(0, value))
  return (
    <RProgress.Root
      value={indeterminate ? null : pct}
      aria-label={label}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-surface-3',
        size === 'sm' ? 'h-1.5' : 'h-2.5',
        className,
      )}
    >
      {indeterminate ? (
        <span
          className={cn(
            'absolute inset-y-0 w-2/5 rounded-full [animation:indeterminate_1.2s_ease-in-out_infinite]',
            tone === 'saffron' ? 'bg-saffron' : 'bg-teal',
          )}
        />
      ) : (
        <RProgress.Indicator
          className={cn(
            'relative h-full rounded-full transition-[width] duration-200 ease-out',
            tone === 'saffron' ? 'bg-saffron' : 'bg-teal',
          )}
          style={{ width: `${pct}%` }}
        >
          {pct > 0 && pct < 100 && (
            <span className="cut-line cut-line--v absolute -right-px -top-0.5 -bottom-0.5 block" />
          )}
        </RProgress.Indicator>
      )}
    </RProgress.Root>
  )
}
