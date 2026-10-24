import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

export type SegKind = 'keep' | 'filler' | 'pause' | 'hook'

export interface Seg {
  id: string
  w: number
  kind: SegKind
}

interface MiniTimelineProps {
  segs: Seg[]
  /** Which kinds have been removed (they collapse with a cut-line flash). */
  removed?: SegKind[]
  /** Only the hook stays; everything else fades out. */
  onlyHook?: boolean
  captions?: boolean
  /** Bumps to replay landing animations. */
  playKey?: number
  className?: string
}

const colors: Record<SegKind, string> = {
  keep: 'border-saffron/50 bg-saffron-soft',
  hook: 'border-saffron bg-saffron/40',
  filler:
    'border-coral/60 bg-coral-soft [background-image:repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_srgb,var(--coral)_45%,transparent)_4px_5px)]',
  pause:
    'border-line-strong bg-surface-3 [background-image:repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_srgb,var(--text)_16%,transparent)_4px_5px)]',
}

/**
 * A small, honest picture of the real timeline: clips as pills. Removed segments collapse
 * behind a cut-line flash and the clips beside them slide together and leap once.
 */
export function MiniTimeline({
  segs,
  removed = [],
  onlyHook,
  captions,
  playKey = 0,
  className,
}: MiniTimelineProps) {
  const isGone = (s: Seg) => removed.includes(s.kind) || (onlyHook && s.kind !== 'hook')
  return (
    <div className={cn('flex flex-col gap-2', className)} role="img" aria-label="Timeline preview">
      <div className="flex h-11 items-stretch gap-[3px]">
        {segs.map((s, i) => {
          const gone = isGone(s)
          return (
            <motion.div
              key={`${s.id}-${playKey}`}
              initial={false}
              animate={{
                flexGrow: gone ? 0 : onlyHook && s.kind === 'hook' ? s.w * 3 : s.w,
                opacity: gone ? 0 : 1,
                marginLeft: gone ? -3 : 0,
                y: gone ? 0 : removed.length || onlyHook ? [0, -7, 0] : 0,
              }}
              transition={{
                flexGrow: { duration: 0.26, ease: [0.2, 0.8, 0.2, 1], delay: gone ? 0 : 0.08 },
                opacity: { duration: 0.18 },
                marginLeft: { duration: 0.26 },
                y: { duration: 0.28, delay: 0.12 + i * 0.015, times: [0, 0.4, 1] },
              }}
              style={{ flexBasis: 0, minWidth: 0 }}
              className={cn('relative overflow-hidden rounded-full border', colors[s.kind])}
            >
              {gone && (
                <motion.span
                  aria-hidden="true"
                  className="cut-line cut-line--v absolute inset-y-0 left-1/2"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                />
              )}
            </motion.div>
          )
        })}
      </div>
      <div className="relative h-6">
        {captions &&
          [0.04, 0.2, 0.36, 0.52, 0.68, 0.84].map((p, i) => (
            <motion.span
              key={`${p}-${playKey}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.06 * i, duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
              className="absolute top-0 h-6 rounded-full border border-line-strong bg-surface-3"
              style={{ left: `${p * 100}%`, width: '14%' }}
            />
          ))}
        {!captions && <div className="absolute inset-x-0 top-1/2 h-px bg-line" />}
      </div>
    </div>
  )
}
