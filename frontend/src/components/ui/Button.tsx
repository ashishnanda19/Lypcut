import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

export const buttonStyles = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full aria-busy:pointer-events-none font-medium transition-[background-color,color,transform,filter] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        primary:
          'btn-cut bg-saffron font-semibold text-saffron-ink hover:bg-saffron-hover disabled:bg-surface-3 disabled:text-faint disabled:opacity-100',
        secondary: 'border border-line bg-surface-2 text-text hover:bg-surface-3',
        ghost: 'text-muted hover:bg-surface-2 hover:text-text',
        teal: 'bg-teal-soft text-teal-text hover:brightness-125',
        danger: 'bg-danger-soft text-danger-text hover:brightness-125',
      },
      size: {
        sm: 'h-8 px-3.5 text-[13px]',
        md: 'h-10 px-5 text-sm',
        lg: 'h-12 px-7 text-base',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  asChild?: boolean
  loading?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, leading, trailing, children, disabled, ...props },
  ref,
) {
  const classes = cn(buttonStyles({ variant, size }), className)

  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    )
  }

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      {...props}
      // While loading the button keeps its colour but ignores clicks.
      onClick={loading ? undefined : props.onClick}
    >
      {loading ? (
        <span aria-hidden="true" className="h-1.5 w-3.5 animate-pulse rounded-full bg-current" />
      ) : (
        leading
      )}
      {children}
      {!loading && trailing}
    </button>
  )
})
