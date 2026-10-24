import type { ReactNode } from 'react'
import * as RDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from './IconButton'

export const Dialog = RDialog.Root
export const DialogTrigger = RDialog.Trigger
export const DialogClose = RDialog.Close

const overlay =
  'fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:[animation:overlay-in_180ms_ease-out_both] data-[state=closed]:[animation:overlay-out_140ms_ease-in_both]'

interface DialogContentProps {
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
  hideTitle?: boolean
  className?: string
  children: ReactNode
}

const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' }

export function DialogContent({
  title,
  description,
  size = 'md',
  hideTitle,
  className,
  children,
}: DialogContentProps) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className={overlay} />
      <RDialog.Content
        aria-describedby={description ? undefined : undefined}
        className={cn(
          'glass fixed left-1/2 top-1/2 z-50 flex max-h-[88dvh] w-[calc(100vw-2rem)] flex-col rounded-panel bg-surface-1 p-6 shadow-lift',
          'data-[state=open]:[animation:dialog-in_200ms_cubic-bezier(0.2,0.8,0.2,1)_both] data-[state=closed]:[animation:dialog-out_140ms_ease-in_both]',
          sizes[size],
          className,
        )}
      >
        <header
          className={cn('mb-4 flex items-start justify-between gap-4', hideTitle && 'sr-only')}
        >
          <div className="min-w-0">
            <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
            {description && (
              <RDialog.Description className="mt-1 text-sm text-muted">
                {description}
              </RDialog.Description>
            )}
          </div>
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

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-6 flex flex-wrap items-center justify-end gap-2', className)}>
      {children}
    </div>
  )
}
