import { scoreWindow, type InsightSentence, type InsightWord } from '../transcription/insights.js'

export const MIN_WINDOW_SEC = 15
export const MAX_WINDOW_SEC = 60
/** Candidates sent to the model. More would cost more and add little: the cheap signals have already ranked them. */
export const MAX_CANDIDATES = 24

export interface CandidateSentence extends InsightSentence {
  speaker: string
}

export interface Candidate {
  id: string
  /** First and last sentence of the window, as positions in the sentence list (inclusive). */
  first: number
  last: number
  /** Source time. The window starts on the first word of a sentence and ends on the last word of one. */
  start: number
  end: number
  text: string
  /** What the cheap checks saw in the opening seconds. */
  signals: string[]
  /** 0-100 from the cheap signals alone: how the candidates are ranked before the model sees them. */
  preScore: number
  /** Words per second, and the share of words that are fillers. */
  pace: number
  fillerShare: number
  /** Whether the window ends where speech naturally breaks (a pause, a new speaker, a picture cut). */
  cleanEnd: boolean
}

export interface CandidateInput {
  sentences: CandidateSentence[]
  words: InsightWord[]
  /** Source times where the picture cuts. */
  sceneCuts: number[]
  duration: number
}

/** A pause this long after a sentence counts as speech breaking naturally. */
const NATURAL_PAUSE_SEC = 0.7
/** A picture cut this close after the window's end counts as ending on the cut. */
const CUT_TOLERANCE_SEC = 1

/**
 * Windows of 15 to 60 seconds that start on the first word of a sentence and end on the last word of one. For each
 * starting sentence a few endings are tried: the shortest that is long enough, the longest that still fits, the one
 * nearest 30 seconds, and any that end where speech breaks. Ranked by the cheap signals, the best are kept, so one
 * moment is not offered as thirty near-identical windows.
 */
export function buildCandidates(input: CandidateInput): Candidate[] {
  const { sentences, words, sceneCuts, duration } = input
  if (!sentences.length || duration < MIN_WINDOW_SEC) return []

  const cuts = [...sceneCuts].sort((a, b) => a - b)
  const breaksAfter = (j: number): boolean => {
    const cur = sentences[j]!
    const next = sentences[j + 1]
    if (!next) return true
    if (next.start - cur.end >= NATURAL_PAUSE_SEC) return true
    if (next.speaker !== cur.speaker) return true
    return cuts.some((c) => c >= cur.end - 0.05 && c - cur.end <= CUT_TOLERANCE_SEC)
  }

  const out: Candidate[] = []
  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[i]!.start
    const ends: number[] = []
    for (let j = i; j < sentences.length; j++) {
      const len = sentences[j]!.end - start
      if (len > MAX_WINDOW_SEC) break
      if (len >= MIN_WINDOW_SEC) ends.push(j)
    }
    if (!ends.length) continue

    const pick = new Set<number>([ends[0]!, ends[ends.length - 1]!])
    const nearest30 = ends.reduce((best, j) =>
      Math.abs(sentences[j]!.end - start - 30) < Math.abs(sentences[best]!.end - start - 30)
        ? j
        : best,
    )
    pick.add(nearest30)
    for (const j of ends) if (pick.size < 4 && breaksAfter(j)) pick.add(j)

    for (const j of [...pick].sort((a, b) => a - b)) {
      const end = sentences[j]!.end
      const scored = scoreWindow(sentences, words, i, { to: j, end })
      const inWindow = words.slice(sentences[i]!.from, sentences[j]!.to)
      const span = Math.max(end - start, 1)
      out.push({
        id: '',
        first: i,
        last: j,
        start,
        end,
        text: sentences
          .slice(i, j + 1)
          .map((s) => s.text)
          .join(' '),
        signals: [...scored.signals].sort(),
        preScore: scored.score,
        pace: Math.round((inWindow.length / span) * 10) / 10,
        fillerShare: inWindow.length
          ? Math.round((inWindow.filter((w) => w.filler).length / inWindow.length) * 100) / 100
          : 0,
        cleanEnd: breaksAfter(j),
      })
    }
  }

  // Best first. Two windows from one opening are the same moment, so at most two lengths per opening are kept.
  out.sort(
    (a, b) =>
      b.preScore - a.preScore ||
      Number(b.cleanEnd) - Number(a.cleanEnd) ||
      a.start - b.start ||
      a.end - b.end,
  )
  const perOpening = new Map<number, number>()
  const kept: Candidate[] = []
  for (const c of out) {
    const n = perOpening.get(c.first) ?? 0
    if (n >= 2) continue
    perOpening.set(c.first, n + 1)
    kept.push(c)
    if (kept.length >= MAX_CANDIDATES) break
  }
  return kept.map((c, n) => ({ ...c, id: `c${n}` }))
}
