import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, CircleAlert, Download } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ProjectStatus } from '@/types'

const badgeStyles = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium leading-5',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-3 text-muted',
        saffron: 'bg-saffron-soft text-accent',
        teal: 'bg-teal-soft text-teal-text',
        coral: 'bg-coral-soft text-coral-text',
        danger: 'bg-danger-soft text-danger-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

interface BadgeProps extends VariantProps<typeof badgeStyles> {
  children: ReactNode
  className?: string
}

export function Badge({ tone, className, children }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)}>{children}</span>
}

/** Project lifecycle chip. */

const statusMeta: Record<
  ProjectStatus,
  { label: string; tone: BadgeProps['tone']; icon: ReactNode }
> = {
  uploading: {
    label: 'Uploading',
    tone: 'teal',
    icon: <span className="size-1.5 animate-pulse rounded-full bg-current" />,
  },
  processing: {
    label: 'Processing',
    tone: 'saffron',
    icon: <span className="size-1.5 animate-pulse rounded-full bg-current" />,
  },
  ready: { label: 'Ready', tone: 'teal', icon: <Check className="size-3" aria-hidden="true" /> },
  exported: {
    label: 'Exported',
    tone: 'neutral',
    icon: <Download className="size-3" aria-hidden="true" />,
  },
  failed: {
    label: 'Needs retry',
    tone: 'danger',
    icon: <CircleAlert className="size-3" aria-hidden="true" />,
  },
}

export function StatusBadge({ status, className }: { status: ProjectStatus; className?: string }) {
  const m = statusMeta[status]
  return (
    <Badge tone={m.tone} className={className}>
      {m.icon}
      {m.label}
    </Badge>
  )
}
