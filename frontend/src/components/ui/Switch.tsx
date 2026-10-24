import { useId } from 'react'
import * as RSwitch from '@radix-ui/react-switch'
import { cn } from '@/lib/cn'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
  className?: string
}

/** A labelled on/off control. The whole row is clickable, and the label is what screen readers read. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  className,
}: SwitchProps) {
  const id = useId()
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-sm font-medium text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </label>
      <RSwitch.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative h-6 w-11 shrink-0 rounded-full border border-line bg-surface-3 transition-colors duration-150 data-[state=checked]:border-saffron data-[state=checked]:bg-saffron disabled:opacity-45"
      >
        <RSwitch.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-text transition-transform duration-150 data-[state=checked]:translate-x-[23px] data-[state=checked]:bg-saffron-ink" />
      </RSwitch.Root>
    </div>
  )
}
