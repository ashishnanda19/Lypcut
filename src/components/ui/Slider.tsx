import { useId, useState } from 'react'
import { cn } from '@/lib/cn'

interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  label: string
  /** Shown to the right of the label. */
  display?: string
  /** Fires while dragging. */
  onChange?: (v: number) => void
  /** Fires when the drag or key press ends: this is where to save. */
  onCommit?: (v: number) => void
  className?: string
}

/** A native range input, styled. Keyboard, touch and screen readers work out of the box. */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  label,
  display,
  onChange,
  onCommit,
  className,
}: SliderProps) {
  const id = useId()
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? value
  const pct = ((shown - min) / (max - min)) * 100
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[13px] font-medium text-muted">
          {label}
        </label>
        {display && <span className="tnum text-xs text-faint">{display}</span>}
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLive(v)
          onChange?.(v)
        }}
        onPointerUp={() => {
          if (live !== null) onCommit?.(live)
          setLive(null)
        }}
        onKeyUp={() => {
          if (live !== null) onCommit?.(live)
          setLive(null)
        }}
        onBlur={() => setLive(null)}
        className="h-5 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-saffron [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--saffron)_var(--pct),var(--surface-3)_var(--pct))] [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-saffron [&::-webkit-slider-thumb]:shadow-soft"
        style={{ ['--pct' as string]: `${pct}%` }}
      />
    </div>
  )
}
