import type { ReactNode } from 'react'
import * as RTooltip from '@radix-ui/react-tooltip'
import { KeyboardShortcutHint } from '@/components/domain/KeyboardShortcutHint'

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RTooltip.Provider delayDuration={350} skipDelayDuration={200}>
    {children}
  </RTooltip.Provider>
)

interface TooltipProps {
  content: ReactNode
  /** Optional shortcut, e.g. ['mod', 'Z']. */
  shortcut?: string[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}

export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={8}
          className="glass z-[100] flex max-w-64 items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium text-text data-[state=delayed-open]:[animation:tooltip-in_140ms_ease-out_both] data-[state=instant-open]:[animation:tooltip-in_100ms_ease-out_both]"
        >
          <span>{content}</span>
          {shortcut && <KeyboardShortcutHint keys={shortcut} />}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
