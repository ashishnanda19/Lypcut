import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/** Placeholder with a soft shimmer. Always give it the final size so nothing shifts on load. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('skeleton rounded-control', className)} {...props} />
}
