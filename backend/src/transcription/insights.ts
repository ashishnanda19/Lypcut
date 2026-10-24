import { hinglishFold } from './fold.js'
import type { BuiltSentence, BuiltWord } from './normalize.js'

/** Just the fields the heuristics read, so rows straight from the database work as well as freshly built ones. */
export type InsightSentence = Pick<BuiltSentence, 'from' | 'to' | 'start' | 'end' | 'text' | 'norm'>
export type InsightWord = Pick<BuiltWord, 'filler'>

/**
 * Hooks and chapters found with plain heuristics, so a project is useful the moment it is ready. Nothing
 * here calls a language model: a later phase can replace the scoring, and the shape of the output (what the
 * editor reads) stays the same.
 */

export interface HighlightCandidate {
  title: string
  start: number
  end: number
  /** 0-100: how likely the opening is to stop a scroll. */
  hookScore: number
  reason: string
}

export interface ChapterCandidate {
  title: string
  start: number
  end: number
}

export interface HighlightOptions {
  /** How many to return at most. */
  count?: number
  minSec?: number
  maxSec?: number
  /** Candidates scoring below this are dropped, unless nothing else qualifies. */
  minScore?: number
}

/** Words that tend to open something worth watching. Roman, lower case, matched against the search form. */
const fold = (words: string[]) => new Set(words.map(hinglishFold))

const STRONG = fold([
  'mistake',
  'mistakes',
  'galti',
  'galat',
  'secret',
  'sach',
  'truth',
  'never',
  'nobody',
  'biggest',
  'sabse',
  'worst',
  'best',
  'free',
  'zero',
  'warning',
  'stop',
  'honest',
  'shocking',
  'raaz',
  'sacchai',
  'kabhi',
  'dhyan',
  'important',
  'lakh',
  'crore',
  'million',
  'billion',
  'percent',
])
const NUMBER_WORDS = fold([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'hundred',
  'thousand',
  'ek',
  'do',
  'teen',
  'chaar',
  'paanch',
  'das',
  'sau',
  'hazaar',
  'bees',
  'chaalis',
])
const CONTRAST = fold(['nahi', 'not', 'but', 'lekin', 'magar', 'par', 'instead'])

const SENTENCE_END = /[.?!।॥…]["'”’)\]]*$/

export interface Scored {
  from: number
  to: number
  start: number
  end: number
  score: number
  signals: Set<'question' | 'number' | 'strong' | 'contrast'>
}

export function findHighlights(
  sentences: InsightSentence[],
  words: InsightWord[],
  duration: number,
  opts: HighlightOptions = {},
): HighlightCandidate[] {
  const count = opts.count ?? 6
  const minSec = opts.minSec ?? 15
  const maxSec = opts.maxSec ?? 45
  const minScore = opts.minScore ?? 45
  if (!sentences.length) return []

  const scored: Scored[] = []
  for (let i = 0; i < sentences.length; i++) {
    const window = windowFrom(sentences, i, minSec, maxSec, duration)
    if (window) scored.push(scoreWindow(sentences, words, i, window))
  }
  if (!scored.length) return []

  scored.sort((a, b) => b.score - a.score || a.start - b.start)
  const picked: Scored[] = []
  for (const c of scored) {
    if (picked.length >= count) break
    if (c.score < minScore && picked.length > 0) break
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue
    picked.push(c)
  }

  return picked
    .map((c) => ({
      title: titleFrom(sentences[c.from]!.text),
      start: round(Math.max(0, c.start - 0.2)),
      end: round(Math.min(duration, c.end + 0.4)),
      hookScore: c.score,
      reason: reasonFor(c.signals),
    }))
    .sort((a, b) => b.hookScore - a.hookScore)
}

/** Sentences from `i` onward until the window is long enough, ending on a sentence boundary. */
function windowFrom(
  sentences: InsightSentence[],
  i: number,
  minSec: number,
  maxSec: number,
  duration: number,
): { to: number; end: number } | null {
  const start = sentences[i]!.start
  let to = i
  for (let j = i; j < sentences.length; j++) {
    const len = sentences[j]!.end - start
    if (len > maxSec && j > i) break
    to = j
    if (len >= minSec) break
  }
  const end = sentences[to]!.end
  // Too short to stand alone, unless the whole recording is that short.
  if (end - start < Math.min(8, duration)) return null
  return { to, end }
}

export function scoreWindow(
  sentences: InsightSentence[],
  words: InsightWord[],
  i: number,
  w: { to: number; end: number },
): Scored {
  const opener = sentences[i]!
  const signals: Scored['signals'] = new Set()
  let score = 30

  const tokens = opener.norm.split(' ').filter(Boolean)
  if (opener.text.includes('?')) {
    score += 12
    signals.add('question')
  }
  if (/\d/.test(opener.text) || tokens.some((t) => NUMBER_WORDS.has(t))) {
    score += 10
    signals.add('number')
  }
  const strong = tokens.filter((t) => STRONG.has(t)).length
  if (strong) {
    score += Math.min(18, strong * 6)
    signals.add('strong')
  }
  if (tokens.some((t) => CONTRAST.has(t))) {
    score += 4
    signals.add('contrast')
  }
  if (tokens.length >= 3 && tokens.length <= 14) score += 8

  const before = sentences[i - 1]
  if (!before || opener.start - before.end >= 0.8) score += 5

  // How the whole window sounds: steady pace is engaging, fillers are not.
  const first = opener.from
  const last = sentences[w.to]!.to
  const inWindow = words.slice(first, last)
  const span = Math.max(w.end - opener.start, 1)
  const pace = inWindow.length / span
  if (pace >= 2 && pace <= 3.6) score += 6
  else if (pace < 1.5) score -= 5
  const fillerShare = inWindow.length
    ? inWindow.filter((x) => x.filler).length / inWindow.length
    : 0
  score -= Math.round(Math.min(12, fillerShare * 60))

  if (SENTENCE_END.test(sentences[w.to]!.text)) score += 4

  return {
    from: i,
    to: w.to,
    start: opener.start,
    end: w.end,
    score: Math.max(0, Math.min(100, Math.round(score))),
    signals,
  }
}

export function reasonFor(signals: Scored['signals']): string {
  if (signals.has('question') && signals.has('number')) {
    return 'Opens with a question and a hard number: it works as a hook on its own.'
  }
  if (signals.has('question')) return 'Opens with a question that makes people want the answer.'
  if (signals.has('number')) return 'Leads with a specific number, which stops the scroll.'
  if (signals.has('strong')) return 'A bold, specific claim that works as a one-line hook.'
  if (signals.has('contrast')) return 'A clear reframe in the opening line.'
  return 'A self-contained moment with a clean start and a steady pace.'
}

/** The opening words as a title: no trailing punctuation, capitalised, and not unreasonably long. */
export function titleFrom(text: string, maxChars = 60): string {
  const plain = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!।॥…-]+$/u, '')
  if (!plain) return 'Untitled moment'
  const cased = plain.charAt(0).toUpperCase() + plain.slice(1)
  if (cased.length <= maxChars) return cased
  const cut = cased.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!-]+$/, '')}…`
}

export interface ChapterOptions {
  /** A chapter is at least this long. */
  minSec?: number
  /** A chapter is cut after this long even without a pause. */
  maxSec?: number
  /** A pause this long (after the minimum length) is a natural chapter break. */
  pauseSec?: number
  /** Never more than this many. */
  maxChapters?: number
}

export function findChapters(
  sentences: InsightSentence[],
  duration: number,
  opts: ChapterOptions = {},
): ChapterCandidate[] {
  if (!sentences.length) return []
  const minSec = opts.minSec ?? 45
  const maxSec = opts.maxSec ?? 150
  const pauseSec = opts.pauseSec ?? 1.2
  const maxChapters = opts.maxChapters ?? 12

  // Indices of the sentences that begin a chapter.
  let starts = [0]
  let chapterStart = sentences[0]!.start
  for (let i = 1; i < sentences.length; i++) {
    const gap = sentences[i]!.start - sentences[i - 1]!.end
    const length = sentences[i]!.start - chapterStart
    const remaining = duration - sentences[i]!.start
    // Never leave a stub of a chapter at the very end.
    if (remaining < minSec / 2) break
    if ((length >= minSec && gap >= pauseSec) || length >= maxSec) {
      starts.push(i)
      chapterStart = sentences[i]!.start
    }
  }
  // Too many chapters: keep an even spread of them.
  if (starts.length > maxChapters) {
    const keep = new Set([
      0,
      ...Array.from({ length: maxChapters - 1 }, (_, k) =>
        Math.round(((k + 1) * starts.length) / maxChapters),
      ),
    ])
    starts = starts.filter((_, k) => keep.has(k))
  }

  return starts.map((idx, k) => {
    const start = k === 0 ? 0 : round(Math.max(0, sentences[idx]!.start - 0.4))
    const next = starts[k + 1]
    const end = next === undefined ? duration : round(Math.max(0, sentences[next]!.start - 0.4))
    return { title: k === 0 ? 'Intro' : chapterTitle(sentences[idx]!.text), start, end }
  })
}

/** The first few words of the opening sentence, as a title. */
export function chapterTitle(text: string): string {
  const head = text.split(/\s+/).slice(0, 6).join(' ')
  return titleFrom(head, 40)
}

/** Label a scene with the chapter it starts in, like the editor's samples do, else "Scene N". */
export function labelScene(start: number, index: number, chapters: ChapterCandidate[]): string {
  // A scene that begins just before a chapter does (chapters start a beat early) belongs to the later one.
  const chapter = chapters.filter((c) => start >= c.start - 0.5 && start < c.end).pop()
  return chapter ? chapter.title : `Scene ${index + 1}`
}

const round = (n: number) => Math.round(n * 100) / 100
