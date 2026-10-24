export interface ScoredWindow {
  start: number
  end: number
  title: string
  hookScore: number
  reason: string
}

/** About one highlight per 90 seconds of video, never fewer than 3 or more than 12. */
export const targetCount = (durationSec: number) =>
  Math.min(12, Math.max(3, Math.round(durationSec / 90)))

const overlaps = (a: ScoredWindow, b: ScoredWindow) => a.start < b.end && a.end > b.start

/**
 * The best windows that do not overlap each other, best first. If the video cannot hold as many separate windows as the
 * target, it returns as many as it can: a short video gets fewer highlights, not overlapping ones.
 */
export function selectHighlights(windows: ScoredWindow[], durationSec: number): ScoredWindow[] {
  const want = targetCount(durationSec)
  const ranked = [...windows].sort(
    (a, b) => b.hookScore - a.hookScore || a.start - b.start || a.end - b.end,
  )
  const picked: ScoredWindow[] = []
  for (const w of ranked) {
    if (picked.length >= want) break
    if (picked.some((p) => overlaps(p, w))) continue
    picked.push(w)
  }
  return picked
}
