import { Check, X } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface StepperStep {
  id: string
  label: string
  description?: string
}

interface StepperProps {
  steps: StepperStep[]
  /** Index of the step being worked on. Pass steps.length when everything is done. */
  current: number
  /** Index of a failed step, if any. */
  failedAt?: number
  className?: string
}

type State = 'done' | 'active' | 'pending' | 'failed'

export function Stepper({ steps, current, failedAt, className }: StepperProps) {
  return (
    <ol className={cn('flex flex-col', className)} aria-label="Progress">
      {steps.map((step, i) => {
        const state: State =
          failedAt === i ? 'failed' : i < current ? 'done' : i === current ? 'active' : 'pending'
        const last = i === steps.length - 1
        return (
          <li
            key={step.id}
            aria-current={state === 'active' ? 'step' : undefined}
            className="relative flex gap-3.5 pb-6 last:pb-0"
          >
            {!last && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-[13px] top-8 h-[calc(100%-2rem)] w-0.5 rounded-full',
                  state === 'done' ? 'bg-teal' : 'bg-line',
                )}
              />
            )}
            <span
              className={cn(
                'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-200',
                state === 'done' && 'border-teal bg-teal text-saffron-ink',
                state === 'active' && 'border-saffron bg-saffron-soft',
                state === 'pending' && 'border-line bg-surface-1',
                state === 'failed' && 'border-danger bg-danger-soft text-danger-text',
              )}
            >
              {state === 'done' && (
                <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
              )}
              {state === 'failed' && <X className="size-3.5" strokeWidth={3} aria-hidden="true" />}
              {state === 'active' && (
                <span className="size-2 rounded-full bg-saffron [animation:leap_620ms_cubic-bezier(0.3,0.7,0.3,1)_infinite]" />
              )}
            </span>
            <div className="min-w-0 pt-0.5">
              <p
                className={cn(
                  'text-sm font-medium',
                  state === 'pending' ? 'text-faint' : 'text-text',
                  state === 'failed' && 'text-danger-text',
                )}
              >
                {step.label}
              </p>
              {step.description && state !== 'pending' && (
                <p className="mt-0.5 text-[13px] text-muted">{step.description}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
