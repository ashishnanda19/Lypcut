/** Seconds -> "m:ss" or "h:mm:ss". Used for durations and ranges. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Seconds -> "mm:ss.t" (tenths). Used for the player and timeline timecode. */
export function formatTimecode(totalSeconds: number): string {
  const t = Math.max(0, totalSeconds)
  const m = Math.floor(t / 60)
  const sec = Math.floor(t % 60)
  const tenth = Math.floor((t * 10) % 10)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenth}`
}

/** "1:05 – 1:42" style range. */
export function formatRange(start: number, end: number): string {
  return `${formatDuration(start)} – ${formatDuration(end)}`
}
