import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import * as RTabs from '@radix-ui/react-tabs'
import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

interface TabsCtx {
  value: string
  id: string
}
const Ctx = createContext<TabsCtx>({ value: '', id: '' })

interface TabsProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  className?: string
  children: ReactNode
}

export function Tabs({ value, defaultValue = '', onValueChange, className, children }: TabsProps) {
  const [inner, setInner] = useState(defaultValue)
  const id = useId()
  const current = value ?? inner
  return (
    <Ctx.Provider value={{ value: current, id }}>
      <RTabs.Root
        value={current}
        onValueChange={(v) => {
          setInner(v)
          onValueChange?.(v)
        }}
        className={className}
      >
        {children}
      </RTabs.Root>
    </Ctx.Provider>
  )
}

export function TabsList({
  className,
  children,
  label,
}: {
  className?: string
  children: ReactNode
  label?: string
}) {
  return (
    <RTabs.List
      aria-label={label}
      className={cn('flex items-center gap-1 rounded-full bg-surface-2 p-1', className)}
    >
      {children}
    </RTabs.List>
  )
}

interface TabsTriggerProps {
  value: string
  icon?: ReactNode
  badge?: ReactNode
  className?: string
  children?: ReactNode
  /** Hide the text and keep it for screen readers (icon-only tabs). */
  iconOnly?: boolean
}

export function TabsTrigger({
  value,
  icon,
  badge,
  className,
  children,
  iconOnly,
}: TabsTriggerProps) {
  const ctx = useContext(Ctx)
  const active = ctx.value === value
  return (
    <RTabs.Trigger
      value={value}
      className={cn(
        'relative flex h-8 min-w-0 flex-1 items-center whitespace-nowrap justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
        active ? 'text-text' : 'text-muted hover:text-text',
        className,
      )}
    >
      {active && (
        <motion.span
          layoutId={`tab-pill-${ctx.id}`}
          className="absolute inset-0 rounded-full bg-surface-3 shadow-soft"
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">
        {icon}
        {children && <span className={cn(iconOnly && 'sr-only')}>{children}</span>}
        {badge}
      </span>
    </RTabs.Trigger>
  )
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string
  className?: string
  children: ReactNode
}) {
  return (
    <RTabs.Content value={value} className={cn('focus-visible:outline-offset-4', className)}>
      {children}
    </RTabs.Content>
  )
}
