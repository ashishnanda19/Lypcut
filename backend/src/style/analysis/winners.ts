import { WINNERS } from './config.js'

export interface Scored {
  id: string
  /** 0-100, or null when the Reel has no usable numbers. */
  score: number | null
}

export interface WinnerSelection {
  /** The Reels the profile is learned from, with how much each counts. Weights add up to 1. */
  winners: Array<{ id: string; weight: number }>
  /** Whether the Reels could be ranked. False means they all count equally. */
  ranked: boolean
}

/**
 * Picks the Reels that show what worked: the best third of the scored ones, and never fewer than three.
 *
 *  - With three or more scored Reels, the winners are the top `ceil(n / 3)` (at least three), weighted by their score.
 *  - With fewer than three scored Reels there is nothing to rank by, so every Reel counts equally. That includes the case
 *    where nobody typed any numbers.
 *  - Reels with no score never win when others have one.
 *
 * Ties at the cut are broken by id, so the same Reels always give the same winners.
 */
export function selectWinners(reels: Scored[]): WinnerSelection {
  if (!reels.length) return { winners: [], ranked: false }
  const scored = reels.filter((r): r is { id: string; score: number } => r.score !== null)
  if (scored.length < WINNERS.min) {
    const each = 1 / reels.length
    return { winners: reels.map((r) => ({ id: r.id, weight: each })), ranked: false }
  }
  const keep = Math.min(
    scored.length,
    Math.max(WINNERS.min, Math.ceil(scored.length * WINNERS.share)),
  )
  const top = [...scored]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, keep)
  // A score of 0 still counts a little: the weight is the score, but never below 1.
  const sum = top.reduce((n, r) => n + Math.max(r.score, 1), 0)
  return {
    winners: top.map((r) => ({ id: r.id, weight: Math.max(r.score, 1) / sum })),
    ranked: true,
  }
}
