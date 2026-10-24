import { useSyncExternalStore } from 'react'

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

const queries =
  typeof window !== 'undefined'
    ? {
        tablet: window.matchMedia('(min-width: 768px)'),
        desktop: window.matchMedia('(min-width: 1180px)'),
      }
    : null

function read(): Breakpoint {
  if (!queries) return 'desktop'
  return queries.desktop.matches ? 'desktop' : queries.tablet.matches ? 'tablet' : 'mobile'
}

function subscribe(cb: () => void) {
  queries?.tablet.addEventListener('change', cb)
  queries?.desktop.addEventListener('change', cb)
  return () => {
    queries?.tablet.removeEventListener('change', cb)
    queries?.desktop.removeEventListener('change', cb)
  }
}

/** Phone, tablet or desktop layout for the editor. Changes only when a boundary is crossed. */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, read, () => 'desktop')
}
