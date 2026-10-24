import type { SemanticWindow } from './semantic.js'
import type { SentenceRow } from './match.js'

/** The usual constant for reciprocal rank fusion: large enough that one list's first place cannot swamp the other's. */
export const RRF_K = 60

export interface LexicalHit {
  sentence: SentenceRow
  score: number
  matched: number[]
}

export interface FusedHit {
  sentence: SentenceRow
  score: number
  matched: number[]
  /** The reciprocal-rank-fusion value that decided whether it made the cut. */
  rrf: number
  from: 'both' | 'lexical' | 'semantic'
}

/**
 * Keeps the windows that are really about the query: at least the model's own floor, and close to the best one. Models
 * differ in how they spread scores (some put unrelated texts near 0, e5 puts everything above 0.75), so "close to the best"
 * is relative to how much room there is above the floor.
 */
export function closeWindows(windows: SemanticWindow[], floor: number, max = 12): SemanticWindow[] {
  if (!windows.length) return []
  const best = windows[0]!.similarity
  const margin = (1 - floor) * 0.4
  return windows.filter((w) => w.similarity >= floor && w.similarity >= best - margin).slice(0, max)
}

/**
 * Merges two ranked lists of moments, by meaning and by words.
 *
 * A lexical hit is a sentence, a semantic hit a window of sentences. A lexical sentence inside a semantic window is the same
 * moment found twice: it is boosted, and ranked by both lists. A window with no lexical sentence in it stands on its own.
 * Reciprocal rank fusion (1 / (60 + rank), summed) decides which moments make the cut; the relevance shown stays the
 * confidence of the best evidence: an exact word match keeps its high score, and a match by meaning alone never outranks
 * one.
 */
export function fuse(
  lexical: LexicalHit[],
  windows: SemanticWindow[],
  floor: number,
  sentenceRow: (idx: number) => SentenceRow | undefined,
): FusedHit[] {
  const lexRanked = [...lexical].sort(
    (a, b) => b.score - a.score || a.sentence.idx - b.sentence.idx,
  )
  const semRank = new Map<SemanticWindow, number>(windows.map((w, i) => [w, i + 1]))
  const covering = (idx: number) => windows.find((w) => idx >= w.first && idx <= w.last)
  const semScore = (w: SemanticWindow) =>
    0.45 + 0.4 * Math.max(0, Math.min(1, (w.similarity - floor) / (1 - floor)))

  const out: FusedHit[] = []
  const usedWindows = new Set<SemanticWindow>()
  lexRanked.forEach((h, i) => {
    const w = covering(h.sentence.idx)
    let rrf = 1 / (RRF_K + i + 1)
    let score = h.score
    let from: FusedHit['from'] = 'lexical'
    if (w) {
      usedWindows.add(w)
      rrf += 1 / (RRF_K + semRank.get(w)!)
      score = Math.min(1, Math.max(h.score, semScore(w)) + 0.05)
      from = 'both'
    }
    out.push({ ...h, score, rrf, from })
  })

  for (const w of windows) {
    if (usedWindows.has(w)) continue
    const first = sentenceRow(w.first)
    const last = sentenceRow(w.last)
    if (!first || !last) continue
    // The window as one "sentence": it starts on a sentence's first word and ends on a sentence's last.
    const sentence: SentenceRow = {
      idx: first.idx,
      from: first.from,
      to: last.to,
      start: w.start,
      end: w.end,
    }
    out.push({
      sentence,
      score: semScore(w),
      matched: [],
      rrf: 1 / (RRF_K + semRank.get(w)!),
      from: 'semantic',
    })
  }
  return out.sort((a, b) => b.rrf - a.rrf || b.score - a.score || a.sentence.idx - b.sentence.idx)
}
