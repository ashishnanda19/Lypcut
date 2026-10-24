import { cn } from '@/lib/cn'

interface AiMarkProps {
  size?: number
  /** Hops while the assistant is working. */
  thinking?: boolean
  className?: string
}

/**
 * The assistant's face: a round clip with a cut-line seam and two eyes.
 * It blinks now and then, and hops while thinking. Not a robot, not a sparkle.
 */
export function AiMark({ size = 28, thinking = false, className }: AiMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 overflow-visible', thinking && 'ai-thinking', className)}
    >
      <circle cx="12" cy="12" r="11" fill="var(--saffron)" />
      <path
        d="M12.9 1.4L11.1 22.6"
        stroke="var(--saffron-ink)"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.85"
      />
      <ellipse className="ai-eye" cx="7.6" cy="11" rx="1.3" ry="1.8" fill="var(--saffron-ink)" />
      <ellipse className="ai-eye" cx="16.4" cy="11" rx="1.3" ry="1.8" fill="var(--saffron-ink)" />
    </svg>
  )
}
