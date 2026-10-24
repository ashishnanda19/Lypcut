const rtf =
  typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null

/** "2 hours ago", "yesterday". */
export function timeAgo(iso: string | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  const diff = Math.round((t - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2592000],
  ]
  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let size = 60
  for (const [u, s] of steps) {
    if (abs >= s) {
      unit = u
      size = s
    }
  }
  return rtf ? rtf.format(Math.round(diff / size), unit) : `${Math.round(abs / size)} ${unit}s ago`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 })
export const compactNumber = (n: number) => compact.format(n)

export function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  if (seconds < 5) return 'a few seconds'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}
