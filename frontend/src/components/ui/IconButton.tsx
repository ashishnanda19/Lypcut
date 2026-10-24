import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

const iconButtonStyles = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        ghost: 'text-muted hover:bg-surface-2 hover:text-text',
        secondary: 'border border-line bg-surface-2 text-text hover:bg-surface-3',
        primary:
          'bg-saffron text-saffron-ink hover:bg-saffron-hover disabled:bg-surface-3 disabled:text-faint disabled:opacity-100',
        active: 'bg-saffron-soft text-accent hover:brightness-125',
      },
      size: { sm: 'size-8', md: 'size-9', lg: 'size-11' },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

interface IconButtonProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>,
    VariantProps<typeof iconButtonStyles> {
  /** Required: icon-only controls need an accessible name. Also shown as the tooltip. */
  label: string
  shortcut?: string[]
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, variant, size, className, children, ...props },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(iconButtonStyles({ variant, size }), className)}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  )
})
