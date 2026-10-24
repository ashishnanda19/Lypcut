import type { ReactNode } from 'react'
import * as RMenu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/cn'

export const DropdownMenu = RMenu.Root
export const DropdownMenuTrigger = RMenu.Trigger

export function DropdownMenuContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={8}
        className={cn(
          'glass z-[100] min-w-52 rounded-card bg-surface-1 p-1.5 data-[state=open]:[animation:tooltip-in_160ms_ease-out_both]',
          className,
        )}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  )
}

interface ItemProps {
  children: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  shortcut?: ReactNode
  disabled?: boolean
}

export function DropdownMenuItem({
  children,
  icon,
  onSelect,
  danger,
  shortcut,
  disabled,
}: ItemProps) {
  return (
    <RMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-3 py-2 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-3',
        danger ? 'text-danger-text' : 'text-text',
      )}
    >
      {icon && (
        <span className="text-faint" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="flex-1">{children}</span>
      {shortcut}
    </RMenu.Item>
  )
}

export const DropdownMenuSeparator = () => <RMenu.Separator className="my-1.5 h-px bg-line" />

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <RMenu.Label className="px-3 py-1.5 text-xs font-medium text-faint">{children}</RMenu.Label>
  )
}
