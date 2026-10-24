import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  leading?: ReactNode
  trailing?: ReactNode
  /** Visually hide the label but keep it for screen readers. */
  hideLabel?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leading, trailing, hideLabel, className, id, ...props },
  ref,
) {
  const auto = useId()
  const inputId = id ?? auto
  const noteId = `${inputId}-note`
  const note = error ?? hint

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={inputId}
          className={cn('text-[13px] font-medium text-muted', hideLabel && 'sr-only')}
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          'flex h-11 items-center gap-2.5 rounded-control border bg-surface-2 px-3.5 transition-colors',
          'focus-within:border-saffron focus-within:bg-surface-1',
          error ? 'border-danger' : 'border-line hover:border-line-strong',
        )}
      >
        {leading && <span className="shrink-0 text-faint">{leading}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-faint focus:outline-none"
          {...props}
        />
        {trailing && <span className="shrink-0 text-faint">{trailing}</span>}
      </div>
      {note && (
        <p id={noteId} className={cn('text-xs', error ? 'text-danger-text' : 'text-faint')}>
          {note}
        </p>
      )}
    </div>
  )
})
