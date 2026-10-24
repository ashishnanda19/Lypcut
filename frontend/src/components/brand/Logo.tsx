import { useId } from 'react'
import { cn } from '@/lib/cn'

interface MarkProps {
  size?: number
  animated?: boolean
  className?: string
}

/* Shape outlines traced from the brand artwork, on its native 1290-unit square. */
const GEM =
  'M500 490L835 347Q900 322 955 345Q985 362 1000 395L1145 735Q1165 785 1140 830Q1120 870 1085 893L895 980Q870 992 845 980L555 865Q530 855 522 835L443 650Q425 600 450 545Q470 510 500 490Z'
const SLAB =
  'M520 945Q560 925 600 942L840 1040Q860 1048 868 1068L1005 1400Q1020 1445 995 1490Q975 1520 940 1535L800 1595Q750 1612 700 1585Q670 1565 655 1530L478 1085Q462 1040 480 1000Q495 962 520 945Z'
const DROP =
  'M1250 873Q1300 868 1350 895Q1420 960 1470 1070Q1520 1170 1500 1260Q1480 1340 1420 1385Q1350 1428 1270 1427Q1160 1420 1070 1340Q975 1250 975 1160Q980 1090 1040 1035Q1100 985 1180 925Q1215 885 1250 873Z'

/* One tonal ramp from the brand saffron (--saffron) to the cut-line coral (--coral). */
const PIECES = [
  { cls: 'mark-gem', shape: <path d={GEM} />, from: '#ffb54d', to: '#ffa83a' },
  { cls: 'mark-orb', shape: <circle cx="1327" cy="572" r="174" />, from: '#ffcf80', to: '#ffc066' },
  { cls: 'mark-slab', shape: <path d={SLAB} />, from: '#ff9553', to: '#ff8447' },
  { cls: 'mark-drop', shape: <path d={DROP} />, from: '#ff7c68', to: '#ff6b57' },
]

/**
 * The Lypcut mark: four flat pieces (gem, orb, slab, drop) cut from one clip.
 * When animated, each piece hops on its own beat and the glow breathes.
 */
export function LogoMark({ size = 28, animated = false, className }: MarkProps) {
  const uid = useId().replace(/:/g, '')
  return (
    <svg
      width={size}
      height={size}
      viewBox="310 320 1290 1290"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 overflow-visible', animated && 'mark-animate', className)}
    >
      <defs>
        {PIECES.map((p) => (
          <linearGradient key={p.cls} id={`${uid}-${p.cls}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={p.from} />
            <stop offset="1" stopColor={p.to} />
          </linearGradient>
        ))}
      </defs>
      <g className="mark-glow">
        {PIECES.map((p) => (
          <g key={p.cls} className={cn('mark-piece', p.cls)}>
            <g fill={`url(#${uid}-${p.cls})`}>{p.shape}</g>
          </g>
        ))}
      </g>
    </svg>
  )
}

interface LogoProps extends MarkProps {
  withWordmark?: boolean
}

export function Logo({ size = 28, animated, withWordmark = true, className }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark size={size} animated={animated} />
      {withWordmark && (
        <span
          className="font-bold leading-none text-text"
          style={{ fontSize: size * 0.82, letterSpacing: '-0.045em' }}
        >
          lypcut
        </span>
      )}
    </span>
  )
}
