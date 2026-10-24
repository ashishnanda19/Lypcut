import { keyLabel } from '@/lib/platform'
import { cn } from '@/lib/cn'

interface KeyboardShortcutHintProps {
  /** e.g. ['mod', 'Shift', 'Z']. "mod" becomes ⌘ on Apple devices and Ctrl elsewhere. */
  keys: string[]
  className?: string
}

export function KeyboardShortcutHint({ keys, className }: KeyboardShortcutHintProps) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${i}`}
          className="tnum inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-surface-3 px-1.5 font-sans text-[11px] font-medium leading-none text-muted"
        >
          {keyLabel(k)}
        </kbd>
      ))}
    </span>
  )
}
