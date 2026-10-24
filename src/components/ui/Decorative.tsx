import type { ReactNode } from 'react'

/**
 * Marketing illustrations that reuse real components (buttons and all) must not be reachable by
 * keyboard or screen reader, so they are hidden and made inert.
 */
export function Decorative({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden="true" className={className} ref={(el) => el?.setAttribute('inert', '')}>
      {children}
    </div>
  )
}
