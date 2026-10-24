import { memo, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

function hash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface PlaceholderThumbProps {
  seed: string
  aspect?: 'video' | 'reel'
  className?: string
  children?: ReactNode
}

/**
 * Stand-in for a video frame until real proxies exist. Deterministic per seed,
 * built from palette colours only, so a grid of clips looks varied but on-brand.
 */
export const PlaceholderThumb = memo(function PlaceholderThumb({
  seed,
  aspect = 'video',
  className,
  children,
}: PlaceholderThumbProps) {
  const h = hash(seed)
  const x1 = 15 + (h % 40)
  const y1 = 20 + ((h >> 3) % 50)
  const x2 = 55 + ((h >> 6) % 35)
  const y2 = 25 + ((h >> 9) % 55)
  const warm = (h >> 12) % 3 === 0 ? 'var(--coral)' : 'var(--saffron)'
  return (
    <div
      aria-hidden={children ? undefined : true}
      className={cn(
        'relative overflow-hidden bg-surface-2',
        aspect === 'video' ? 'aspect-video' : 'aspect-[9/16]',
        className,
      )}
      style={{
        backgroundImage: [
          `radial-gradient(55% 70% at ${x1}% ${y1}%, color-mix(in srgb, ${warm} 34%, transparent), transparent 72%)`,
          `radial-gradient(50% 65% at ${x2}% ${y2}%, color-mix(in srgb, var(--teal) 28%, transparent), transparent 70%)`,
          'repeating-linear-gradient(115deg, transparent 0 9px, color-mix(in srgb, var(--text) 3%, transparent) 9px 10px)',
        ].join(','),
      }}
    >
      {children}
    </div>
  )
})
