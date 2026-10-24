import { useId } from 'react'
import * as RSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  label?: string
  placeholder?: string
  className?: string
}

export function Select({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  className,
}: SelectProps) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-muted">
          {label}
        </label>
      )}
      <RSelect.Root value={value} onValueChange={onValueChange}>
        <RSelect.Trigger
          id={id}
          className="flex h-11 w-full items-center justify-between gap-2 rounded-control border border-line bg-surface-2 px-3.5 text-sm text-text transition-colors hover:border-line-strong data-[state=open]:border-saffron data-[placeholder]:text-faint"
        >
          <RSelect.Value placeholder={placeholder} />
          <RSelect.Icon>
            <ChevronDown className="size-4 text-faint" aria-hidden="true" />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content
            position="popper"
            sideOffset={6}
            className="glass z-[100] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card p-1.5 data-[state=open]:[animation:tooltip-in_160ms_ease-out_both]"
          >
            <RSelect.Viewport>
              {options.map((o) => (
                <RSelect.Item
                  key={o.value}
                  value={o.value}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-xl px-3 py-2 text-sm text-text outline-none data-[highlighted]:bg-surface-3"
                >
                  <RSelect.ItemText>{o.label}</RSelect.ItemText>
                  {o.hint && <span className="text-xs text-faint">{o.hint}</span>}
                  <RSelect.ItemIndicator className="ml-auto">
                    <Check className="size-4 text-accent" aria-hidden="true" />
                  </RSelect.ItemIndicator>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </div>
  )
}
