import { memo, useMemo } from 'react'

function seeded(seed: string) {
  let s = 2166136261
  for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619)
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507)
    s = Math.imul(s ^ (s >>> 13), 3266489909)
    return ((s ^= s >>> 16) >>> 0) / 4294967296
  }
}

interface WaveformProps {
  seed: string
  width: number
  height: number
}

/** Bars drawn as one <path>, so a lane with dozens of clips stays cheap to paint. */
export const Waveform = memo(function Waveform({ seed, width, height }: WaveformProps) {
  const d = useMemo(() => {
    const rand = seeded(seed)
    const step = 3
    const n = Math.max(1, Math.floor(width / step))
    const mid = height / 2
    let path = ''
    let envelope = 0.5
    for (let i = 0; i < n; i++) {
      envelope = envelope * 0.7 + rand() * 0.3 + (rand() > 0.92 ? 0.25 : 0)
      const h = Math.max(1.5, Math.min(1, envelope) * (height - 4))
      path += `M${i * step + 1} ${mid - h / 2}v${h}`
    }
    return path
  }, [seed, width, height])

  return (
    <svg width={width} height={height} aria-hidden="true" className="block">
      <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
})
