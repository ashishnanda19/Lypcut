import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const chip = cva('inline-flex items-center gap-2 rounded-full py-1 pl-2.5 pr-3 text-xs', {
  variants: {
    tone: {
      neutral: 'bg-surface-3 text-muted',
      saffron: 'bg-saffron-soft text-accent',
      teal: 'bg-teal-soft text-teal-text',
      coral: 'bg-coral-soft text-coral-text',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

interface MetricChipProps extends VariantProps<typeof chip> {
  label: string
  value: ReactNode
  icon?: ReactNode
  className?: string
}

/** Small label + number pill: "Cuts  3", "Saved  0:42", "Views  1.2M". */
export function MetricChip({ label, value, icon, tone, className }: MetricChipProps) {
  return (
    <span className={cn(chip({ tone }), className)}>
      {icon}
      <span className="opacity-80">{label}</span>
      <span className="tnum font-semibold text-text">{value}</span>
    </span>
  )
}
