import { ENGAGEMENT } from './config.js'

/**
 * One Reel's numbers, as the score needs them. Every field may be missing; missing is never 0 here.
 * `avgWatchPct` is 0-100.
 */
export interface ReelNumbers {
  views?: number | null
  reach?: number | null
  likes?: number | null
  comments?: number | null
  saves?: number | null
  shares?: number | null
  avgWatchPct?: number | null
  /** When it was posted. Unknown for an upload, which is then never "too new". */
  postedAt?: Date | null
}

export type Signal = keyof typeof ENGAGEMENT.weights
export type Signals = Partial<Record<Signal, number>>

/**
 * Average watch time in seconds, which is what Instagram reports, as a share of the Reel's length. Null when either is
 * unknown, so a percentage is never invented.
 */
export function watchPct(
  avgWatchSec: number | null | undefined,
  durationSec: number | null | undefined,
) {
  if (avgWatchSec == null || !durationSec || durationSec <= 0) return null
  return Math.max(0, Math.min(100, (avgWatchSec / durationSec) * 100))
}

/** What the rates are measured against: views, or reach when views are missing. */
const denominator = (n: ReelNumbers) =>
  n.views && n.views > 0 ? n.views : n.reach && n.reach > 0 ? n.reach : null

/** The signals a Reel has: rates per view, and the share of the Reel people watched. Missing ones are left out. */
export function signalsOf(n: ReelNumbers): Signals {
  const out: Signals = {}
  const per = denominator(n)
  if (per) {
    if (n.saves != null) out.saves = n.saves / per
    if (n.shares != null) out.shares = n.shares / per
    if (n.comments != null) out.comments = n.comments / per
    if (n.likes != null) out.likes = n.likes / per
  }
  if (n.avgWatchPct != null) out.watch = n.avgWatchPct / 100
  return out
}

export type SkipReason = 'too_few_views' | 'too_new' | 'too_few_signals'

/** Whether a Reel can be scored, and if not why not. */
export function skipReason(n: ReelNumbers, now: Date): SkipReason | null {
  if (n.postedAt && now.getTime() - n.postedAt.getTime() < ENGAGEMENT.minAgeDays * 86_400_000)
    return 'too_new'
  const seen = n.views ?? n.reach
  if (seen != null && seen < ENGAGEMENT.minViews) return 'too_few_views'
  if (Object.keys(signalsOf(n)).length < ENGAGEMENT.minSignals) return 'too_few_signals'
  return null
}

/** The share of `values` below `v`, counting ties as half: 0-100, and 50 when there is nothing to compare with. */
function percentile(v: number, values: number[]): number {
  if (values.length < 2) return 50
  let below = 0
  let equal = 0
  for (const x of values) {
    if (x < v) below++
    else if (x === v) equal++
  }
  return ((below + (equal - 1) / 2) / (values.length - 1)) * 100
}

/**
 * Scores each Reel from 0 to 100 **against the creator's own other Reels**, so a small account is not punished for small
 * numbers. For every signal the Reel has, its rate is ranked among the creator's rates for that signal; the score is the
 * weighted average of those ranks, over the signals the Reel has (so a Reel with no watch time is not marked down for
 * it). A Reel that cannot be scored gets null, and the reason is given.
 */
export function engagementScores(
  reels: Array<{ id: string; numbers: ReelNumbers | null }>,
  now: Date = new Date(),
): Map<string, { score: number | null; skipped: SkipReason | 'no_numbers' | null }> {
  const out = new Map<string, { score: number | null; skipped: SkipReason | 'no_numbers' | null }>()
  const usable: Array<{ id: string; signals: Signals }> = []
  for (const r of reels) {
    if (!r.numbers) {
      out.set(r.id, { score: null, skipped: 'no_numbers' })
      continue
    }
    const why = skipReason(r.numbers, now)
    if (why) out.set(r.id, { score: null, skipped: why })
    else usable.push({ id: r.id, signals: signalsOf(r.numbers) })
  }

  const pool: Record<string, number[]> = {}
  for (const u of usable) for (const [k, v] of Object.entries(u.signals)) (pool[k] ??= []).push(v)

  for (const u of usable) {
    let weighted = 0
    let total = 0
    for (const [k, v] of Object.entries(u.signals)) {
      const w = ENGAGEMENT.weights[k as Signal]
      weighted += w * percentile(v, pool[k]!)
      total += w
    }
    out.set(u.id, { score: Math.round((weighted / total) * 10) / 10, skipped: null })
  }
  return out
}
