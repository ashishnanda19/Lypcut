import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SectionProps {
  id: string
  title: string
  description?: string
  children: ReactNode
  className?: string
}

export function Section({ id, title, description, children, className }: SectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 py-12">
      <div className="mb-7 max-w-xl">
        <h2 id={`${id}-h`} className="text-2xl font-bold tracking-tight">
          {title}
        </h2>
        {description && <p className="mt-2 text-[15px] text-muted">{description}</p>}
      </div>
      <div className={className}>{children}</div>
    </section>
  )
}

/** A bordered stage for showing one component or a small group of them. */
export function Stage({
  title,
  children,
  className,
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className="rounded-panel border border-line bg-surface-1 p-5">
      {title && <h3 className="mb-4 text-sm font-semibold text-muted">{title}</h3>}
      <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
    </div>
  )
}
