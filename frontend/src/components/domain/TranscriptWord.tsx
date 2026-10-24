import { memo } from 'react'
import { cn } from '@/lib/cn'

interface TranscriptWordProps {
  text: string
  /** Index in the transcript. The parent reads it from data-i for delegated clicks. */
  index: number
  current?: boolean
  cut?: boolean
  selected?: boolean
  filler?: boolean
}

/**
 * One word. Deliberately stateless and memoised: a one-hour transcript has
 * thousands of these, so the parent attaches a single delegated click handler
 * and re-renders only the words whose flags changed.
 */
export const TranscriptWord = memo(function TranscriptWord({
  text,
  index,
  current,
  cut,
  selected,
  filler,
}: TranscriptWordProps) {
  return (
    <span
      data-i={index}
      title={cut ? 'Cut. Click to restore' : undefined}
      className={cn(
        'cursor-pointer rounded-md px-[3px] py-0.5 transition-colors duration-100',
        !current && !selected && !cut && 'hover:bg-surface-3',
        current && 'bg-saffron font-medium text-saffron-ink',
        selected && !current && 'bg-teal-soft text-teal-text',
        filler &&
          !cut &&
          !current &&
          'underline decoration-teal decoration-dotted decoration-2 underline-offset-4',
        cut &&
          'text-faint line-through decoration-coral decoration-2 opacity-75 hover:bg-coral-soft',
      )}
    >
      {text}
    </span>
  )
})
