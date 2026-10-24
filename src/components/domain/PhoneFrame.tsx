import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PhoneFrameProps {
  /** Frame width in pixels. Height follows the 9:16 screen. */
  width?: number
  /** Overlay the zones that Reels app UI covers (top bar, caption area, side rail). */
  safeZones?: boolean
  children?: ReactNode
  className?: string
}

/** 9:16 preview. Safe zones show where on-screen app controls will sit over the video. */
export function PhoneFrame({
  width = 240,
  safeZones = false,
  children,
  className,
}: PhoneFrameProps) {
  return (
    <div
      className={cn(
        'rounded-[2.6rem] border border-line-strong bg-[#07090c] p-2 shadow-lift',
        className,
      )}
      style={{ width }}
    >
      <div className="relative aspect-[9/16] overflow-hidden rounded-[2.1rem] bg-[#0b0d11]">
        {children}

        <span
          aria-hidden="true"
          className="absolute left-1/2 top-2 z-20 h-4 w-[28%] -translate-x-1/2 rounded-full bg-black"
        />

        {safeZones && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
            <div className="absolute inset-x-0 top-0 h-[12%] border-b border-dashed border-teal/70 bg-teal/10" />
            <div className="absolute inset-x-0 bottom-0 h-[24%] border-t border-dashed border-teal/70 bg-teal/10" />
            <div className="absolute bottom-[24%] right-0 top-[12%] w-[15%] border-l border-dashed border-teal/70 bg-teal/10" />
            <span className="absolute bottom-[10%] left-3 h-2 w-[42%] rounded-full bg-white/25" />
            <span className="absolute bottom-[5%] left-3 h-2 w-[28%] rounded-full bg-white/15" />
            <span className="absolute bottom-[30%] right-[3.5%] flex flex-col items-center gap-2.5">
              <i className="size-5 rounded-full bg-white/25" />
              <i className="size-5 rounded-full bg-white/25" />
              <i className="size-5 rounded-full bg-white/25" />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
