import { motion } from 'framer-motion'
import { Check, Eye, Undo2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { leap } from '@/lib/motion'
import { Button } from '@/components/ui/Button'
import { CutLine } from '@/components/brand/CutLine'
import { MetricChip } from './MetricChip'

export type EditCardStatus = 'proposed' | 'previewing' | 'applied' | 'undone'

export interface StripSegment {
  kind: 'keep' | 'cut' | 'add'
  /** Relative width. */
  weight: number
}

interface EditCardProps {
  title: string
  description: string
  status: EditCardStatus
  /** A tiny before/after picture of the change: kept, cut and added stretches. */
  strip?: StripSegment[]
  summary?: { label: string; value: string; tone?: 'neutral' | 'saffron' | 'teal' | 'coral' }[]
  onPreview?: () => void
  onApply?: () => void
  onUndo?: () => void
  className?: string
}

const segmentStyle: Record<StripSegment['kind'], string> = {
  keep: 'bg-surface-3',
  cut: 'bg-coral-soft [background-image:repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_srgb,var(--coral)_45%,transparent)_4px_5px)]',
  add: 'bg-teal-soft border border-teal/60',
}

/**
 * Every AI action in the chat lands as one of these. It is the most important
 * card in the product: say what will change, show it, let the person try it
 * and take it back.
 */
export function EditCard({
  title,
  description,
  status,
  strip,
  summary,
  onPreview,
  onApply,
  onUndo,
  className,
}: EditCardProps) {
  const applied = status === 'applied'
  const previewing = status === 'previewing'

  return (
    <motion.section
      variants={leap}
      initial="rest"
      animate={applied ? 'jump' : 'rest'}
      aria-label={`Edit: ${title}`}
      className={cn(
        'glass relative overflow-hidden rounded-card p-4 pl-5',
        applied && 'landed-glow',
        status === 'undone' && 'opacity-70',
        className,
      )}
    >
      <span className="absolute inset-y-3 left-0 w-0.5">
        <CutLine flash={applied} flashKey={status} className={cn(!applied && 'opacity-40')} />
      </span>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-text">{title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
        </div>
        <span aria-live="polite" className="shrink-0 text-xs font-medium text-faint">
          {applied
            ? 'Applied'
            : status === 'undone'
              ? 'Undone'
              : previewing
                ? 'Previewing'
                : 'Suggested'}
        </span>
      </div>

      {strip && (
        <div
          role="img"
          aria-label="Preview of the change: kept, cut and added parts of the timeline"
          className="mt-3.5 flex h-3.5 items-stretch gap-[3px]"
        >
          {strip.map((s, i) => (
            <span
              key={i}
              className={cn('rounded-full', segmentStyle[s.kind])}
              style={{ flexGrow: s.weight, flexBasis: 0 }}
            />
          ))}
        </div>
      )}

      {summary && summary.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {summary.map((m) => (
            <MetricChip key={m.label} label={m.label} value={m.value} tone={m.tone} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-pressed={previewing}
          leading={<Eye className="size-3.5" aria-hidden="true" />}
          onClick={onPreview}
          disabled={applied}
        >
          {previewing ? 'Stop preview' : 'Preview'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          leading={<Check className="size-3.5" aria-hidden="true" />}
          onClick={onApply}
          disabled={applied}
        >
          {applied ? 'Applied' : 'Apply'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          leading={<Undo2 className="size-3.5" aria-hidden="true" />}
          onClick={onUndo}
          disabled={!applied}
        >
          Undo
        </Button>
      </div>
    </motion.section>
  )
}
