import { PROFILE } from './config.js'
import type { WinnerSelection } from './winners.js'

/** What was measured in one Reel (a `reel_analysis` row, with the extra numbers the profile needs). */
export interface ReelFacts {
  id: string
  /** When it was posted, or when it was uploaded: orders the "last Reels" retention chart. */
  at: Date
  hookTimingSec: number | null
  cutPace: number
  durationSec: number
  /** An editor caption style id, `custom`, or null when the Reel has no captions. */
  captionStyleId: string | null
  fonts: string[]
  colors: string[]
  /** 0-1: the share who left in the first three seconds, where Instagram said. */
  skipRate: number | null
  /** Whether the Reel had any numbers at all. */
  hasMetrics: boolean
}

export type Confidence = 'low' | 'medium' | 'high'

/**
 * The shape the front end reads (`StyleProfile` in frontend/src/types), minus `connected`, `source` and `handle`, which
 * belong to the account, and plus what the server needs.
 */
export interface DerivedProfile {
  reelsAnalysed: number
  hookTimingSec: number
  /** Cuts per 10 seconds. */
  cutPace: number
  captionStyles: Array<{ id: string; share: number }>
  /** Music is not learned or stored (decided for V1). The field stays so the front end's type is unchanged. */
  music: Array<{ label: string; share: number }>
  /** First-3-seconds retention (0-100) of the most recent Reels, oldest first. Empty unless Instagram said. */
  hookRetention: number[]
  fonts: string[]
  colors: string[]
  confidence: Confidence
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Weighted mean of the values that exist. Null if none do. */
function weightedMean(items: Array<{ value: number | null; weight: number }>): number | null {
  let sum = 0
  let total = 0
  for (const i of items) {
    if (i.value === null) continue
    sum += i.value * i.weight
    total += i.weight
  }
  return total ? sum / total : null
}

/** Shares that add up to exactly 1: rounded to four places, with the rounding left over given to the biggest. */
function shares(weights: Map<string, number>): Array<{ id: string; share: number }> {
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  if (!total) return []
  const rows = [...weights.entries()]
    .map(([id, w]) => ({ id, share: Math.round((w / total) * 10_000) / 10_000 }))
    .sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))
  const left = Math.round((1 - rows.reduce((n, r) => n + r.share, 0)) * 10_000) / 10_000
  rows[0]!.share = Math.round((rows[0]!.share + left) * 10_000) / 10_000
  return rows
}

function top(weights: Map<string, number>, n: number): string[] {
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k)
}

export function confidenceOf(reels: number, withMetrics: number, ranked: boolean): Confidence {
  // Fewer than three Reels, or nothing to rank them by, is never more than low.
  if (reels < 3 || !ranked) return 'low'
  if (reels >= PROFILE.high.reels && withMetrics >= PROFILE.high.withMetrics) return 'high'
  if (reels >= PROFILE.medium.reels && withMetrics >= PROFILE.medium.withMetrics) return 'medium'
  return 'low'
}

/**
 * Builds the profile from the winners: timing, cut pace, caption looks, fonts and colours are averaged or tallied over the
 * winning Reels, each counting by its weight. Nothing here is a model's opinion; it is arithmetic on measurements.
 */
export function buildProfile(reels: ReelFacts[], selection: WinnerSelection): DerivedProfile {
  const byId = new Map(reels.map((r) => [r.id, r]))
  const winners = selection.winners
    .map((w) => ({ reel: byId.get(w.id), weight: w.weight }))
    .filter((w): w is { reel: ReelFacts; weight: number } => !!w.reel)

  const hook = weightedMean(winners.map((w) => ({ value: w.reel.hookTimingSec, weight: w.weight })))
  const pace = weightedMean(winners.map((w) => ({ value: w.reel.cutPace, weight: w.weight })))

  const styleWeights = new Map<string, number>()
  const fontWeights = new Map<string, number>()
  const colorWeights = new Map<string, number>()
  for (const { reel, weight } of winners) {
    if (reel.captionStyleId)
      styleWeights.set(reel.captionStyleId, (styleWeights.get(reel.captionStyleId) ?? 0) + weight)
    for (const f of reel.fonts) fontWeights.set(f, (fontWeights.get(f) ?? 0) + weight)
    for (const c of reel.colors) colorWeights.set(c, (colorWeights.get(c) ?? 0) + weight)
  }

  const recent = reels
    .filter((r) => r.skipRate !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))
    .slice(-PROFILE.retentionReels)

  return {
    reelsAnalysed: reels.length,
    hookTimingSec: round1(hook ?? 0),
    cutPace: round1(pace ?? 0),
    captionStyles: shares(styleWeights),
    // No music is detected, classified or stored in V1. The front end's type keeps the field, so it is always empty.
    music: [],
    hookRetention: recent.map((r) => Math.round((1 - r.skipRate!) * 100)),
    fonts: top(fontWeights, PROFILE.maxFonts),
    colors: top(colorWeights, PROFILE.maxColors),
    confidence: confidenceOf(
      reels.length,
      reels.filter((r) => r.hasMetrics).length,
      selection.ranked,
    ),
  }
}
