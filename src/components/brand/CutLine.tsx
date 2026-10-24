import { cn } from '@/lib/cn'

interface CutLineProps {
  orientation?: 'vertical' | 'horizontal'
  /** Plays the one-shot flash. Change `flashKey` to replay it. */
  flash?: boolean
  flashKey?: string | number
  className?: string
}

/** The signature motif: a thin glowing line wherever the AI cuts. */
export function CutLine({
  orientation = 'vertical',
  flash = false,
  flashKey,
  className,
}: CutLineProps) {
  return (
    <span
      key={flashKey}
      aria-hidden="true"
      className={cn(
        'cut-line block',
        orientation === 'vertical' ? 'cut-line--v h-full' : 'cut-line--h w-full',
        flash && 'cut-line--flash',
        className,
      )}
    />
  )
}
