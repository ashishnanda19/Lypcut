import { cn } from '@/lib/cn'

interface LeapLoaderProps {
  label?: string
  className?: string
}

/** Loader: a clip hops over a cut-line, again and again. */
export function LeapLoader({ label = 'Loading', className }: LeapLoaderProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn('relative inline-block h-8 w-16 align-middle', className)}
    >
      <span className="absolute bottom-0 left-1/2 h-6 w-0.5 -translate-x-1/2 cut-line" />
      <span
        className="absolute bottom-0.5 left-[calc(50%-8px)] h-2.5 w-4 rounded-full bg-saffron animate-hop"
        style={{ transformOrigin: '50% 100%' }}
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}
