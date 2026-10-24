import type { ReactNode } from 'react'
import * as RDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'

export const Sheet = RDialog.Root
export const SheetTrigger = RDialog.Trigger
export const SheetClose = RDialog.Close

type Side = 'right' | 'left' | 'bottom'

const sideStyles: Record<Side, string> = {
  right:
    'inset-y-0 right-0 w-[min(26rem,100vw)] rounded-l-panel data-[state=open]:[animation:sheet-in-right_240ms_cubic-bezier(0.2,0.8,0.2,1)_both] data-[state=closed]:[animation:sheet-out-right_180ms_ease-in_both]',
  left: 'inset-y-0 left-0 w-[min(26rem,100vw)] rounded-r-panel data-[state=open]:[animation:sheet-in-left_240ms_cubic-bezier(0.2,0.8,0.2,1)_both] data-[state=closed]:[animation:sheet-out-left_180ms_ease-in_both]',
  bottom:
    'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-panel data-[state=open]:[animation:sheet-in-bottom_240ms_cubic-bezier(0.2,0.8,0.2,1)_both] data-[state=closed]:[animation:sheet-out-bottom_180ms_ease-in_both]',
}

interface SheetContentProps {
  title: string
  description?: string
  side?: Side
  className?: string
  children: ReactNode
}

export function SheetContent({
  title,
  description,
  side = 'right',
  className,
  children,
}: SheetContentProps) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:[animation:overlay-in_180ms_ease-out_both] data-[state=closed]:[animation:overlay-out_140ms_ease-in_both]" />
      <RDialog.Content
        className={cn(
          'glass fixed z-50 flex flex-col bg-surface-1 p-6 shadow-lift',
          sideStyles[side],
          className,
        )}
      >
        <header className="mb-4 pr-10">
          <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
          {description && (
            <RDialog.Description className="mt-1 text-sm text-muted">
              {description}
            </RDialog.Description>
          )}
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        <RDialog.Close asChild>
          <IconButton label="Close" size="sm" className="absolute right-4 top-4">
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        </RDialog.Close>
      </RDialog.Content>
    </RDialog.Portal>
  )
}
