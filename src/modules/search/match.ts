import { foldForSearch } from '../../transcription/fold.js'
import { knownDevanagari, knownRoman } from '../../transcription/lexicon.js'
import { devanagariToRoman, hasDevanagari } from '../../transcription/translit.js'
import { groupMembers, groupOf, tokenize } from './groups.js'

/**
 * "Find the moment" ranking. The scoring is the front end's (src/lib/search.ts): drop filler words from a natural
 * query, weigh each query word against each word of a sentence (exact, prefix, synonym, one typo), average across the
 * query, keep sentences above a threshold, widen short ones with the next sentence for context, and never return two
 * overlapping clips. What differs is that words are compared by their spelling-folded key, so the variants speech
 * recognition produces ("phunding" for "funding") match, and that the database narrows candidates first.
 */

const STOP = new Set(
  (
    'where i talk talked talks about the a an is are to of in on at my me when what which find show part moment clip ' +
    'for with and or that this it we you your do did does jahan jaha kahan kab main maine mein ne ka ki ke ko se par ' +
    'hai hain tha thi baat baare bare wala wali wo woh ye yeh aur mera meri mere kar karte karta karti kiya kiye ' +
    'bola bataya batao dhoondo dikhao dikha mujhe bata bol raha rahi'
  ).split(' '),
)

/** One word of the query, in every form it can be compared in. */
export interface QueryTerm {
  /** The word as typed, lower-cased. */
  raw: string
  /** Its Roman, spelling-folded key: what stored words are compared against. */
  key: string
  /** The Devanagari spelling, if it was typed in Devanagari or is a word we know. */
  dev?: string
  group?: number
}

export function queryTerms(query: string): QueryTerm[] {
  const out: QueryTerm[] = []
  for (const raw of tokenize(query)) {
    if (STOP.has(raw)) continue
    if (hasDevanagari(raw)) {
      const roman = knownRoman(raw) ?? devanagariToRoman(raw)
      out.push({ raw, key: foldForSearch(roman), dev: raw, group: groupOf(raw) })
    } else {
      out.push({ raw, key: foldForSearch(raw), dev: knownDevanagari(raw), group: groupOf(raw) })
    }
  }
  return out
}

/** The parts of a stored word that matching looks at. */
export interface MatchWord {
  /** The Roman, spelling-folded key (what the pipeline stores as `norm`). */
  norm: string
  /** The Devanagari spelling as stored, punctuation included. */
  dev: string
}

function atMostOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** 0 = no match, otherwise between 0.5 and 1. Both arguments are in the same form (both folded Roman, or both Devanagari). */
export function keyWeight(q: string, w: string): number {
  if (!q || !w) return 0
  if (q === w) return 1
  if (q.length >= 3 && w.startsWith(q)) return 0.78
  if (w.length >= 4 && q.startsWith(w) && q.length - w.length <= 2) return 0.7
  if (q.length >= 5 && w.length >= 5 && atMostOneEdit(q, w)) return 0.55
  return 0
}

export function matchWeight(term: QueryTerm, word: MatchWord): number {
  let best = keyWeight(term.key, word.norm)
  const devToken = tokenize(word.dev).join('')
  if (term.dev) best = Math.max(best, keyWeight(term.dev, devToken))
  if (best < 0.62 && term.group !== undefined) {
    if (groupOf(word.norm) === term.group || (devToken && groupOf(devToken) === term.group))
      best = 0.62
  }
  return best
}

export interface SentenceRow {
  idx: number
  from: number
  to: number
  start: number
  end: number
}

export interface SearchHit {
  id: string
  start: number
  end: number
  /** 0-100. */
  relevance: number
  /** Word indices (into the whole transcript) that matched. */
  matched: number[]
  /** The word range of the matched sentence window. */
  from: number
  to: number
  thumbSeed: string
}

const THRESHOLD = 0.45

/** Scores one sentence against the query. Returns null when it does not reach the threshold. */
export function scoreSentence(
  terms: QueryTerm[],
  sentence: SentenceRow,
  wordAt: (idx: number) => MatchWord | undefined,
): { score: number; matched: number[] } | null {
  let total = 0
  const matched: number[] = []
  for (const term of terms) {
    let best = 0
    let bestIdx = -1
    for (let i = sentence.from; i < sentence.to; i++) {
      const word = wordAt(i)
      if (!word) continue
      const weight = matchWeight(term, word)
      if (weight > best) {
        best = weight
        bestIdx = i
      }
    }
    total += best
    if (bestIdx >= 0 && best > 0) matched.push(bestIdx)
  }
  const score = total / terms.length
  return score >= THRESHOLD ? { score, matched } : null
}

/**
 * Turns scored sentences into clips: best first, a short sentence widened with the one after it for context, no two
 * clips overlapping, at most `limit` of them, ordered by relevance.
 */
export function assembleResults(
  hits: Array<{ sentence: SentenceRow; score: number; matched: number[] }>,
  nextSentence: (idx: number) => SentenceRow | undefined,
  limit: number,
): SearchHit[] {
  const ranked = [...hits].sort((a, b) => b.score - a.score || a.sentence.idx - b.sentence.idx)
  const results: SearchHit[] = []
  const used: Array<[number, number]> = []
  for (const h of ranked) {
    const s = h.sentence
    // A short sentence makes a weak clip: pull in the next one.
    const next = s.end - s.start < 7 ? nextSentence(s.idx) : undefined
    const last = next ?? s
    const start = Math.max(0, s.start - 0.3)
    const end = last.end + 0.4
    if (used.some(([a, b]) => start < b && end > a)) continue
    used.push([start, end])
    results.push({
      id: `sr_${s.idx}`,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      relevance: Math.max(
        40,
        Math.min(99, Math.round(h.score * 90 + Math.min(h.matched.length, 3) * 3)),
      ),
      matched: [...new Set(h.matched)].sort((a, b) => a - b),
      from: s.from,
      to: last.to,
      thumbSeed: `search-${s.idx}`,
    })
    if (results.length >= limit) break
  }
  return results.sort((a, b) => b.relevance - a.relevance)
}

/** The whole algorithm over an in-memory transcript. The service narrows with the database first, then calls the same pieces. */
export function searchInMemory(
  sentences: SentenceRow[],
  words: MatchWord[],
  query: string,
  limit = 8,
): SearchHit[] {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const hits: Array<{ sentence: SentenceRow; score: number; matched: number[] }> = []
  for (const sentence of sentences) {
    const scored = scoreSentence(terms, sentence, (i) => words[i])
    if (scored) hits.push({ sentence, ...scored })
  }
  return assembleResults(hits, (idx) => sentences.find((s) => s.idx === idx + 1), limit)
}

/**
 * What to look for in the database for a query: Roman keys (folded, so ASCII) and Devanagari words, including every
 * member of each word's topic group. The database only narrows; the scoring above decides.
 */
export function candidateForms(terms: QueryTerm[]): { roman: string[]; dev: string[] } {
  const roman = new Set<string>()
  const dev = new Set<string>()
  for (const t of terms) {
    if (t.key) roman.add(t.key)
    if (t.dev) dev.add(tokenize(t.dev).join(''))
    if (t.group !== undefined) {
      const g = groupMembers(t.group)
      g.roman.forEach((k) => roman.add(k))
      g.dev.forEach((k) => dev.add(k))
    }
  }
  const keep = (set: Set<string>) => [...set].filter(Boolean)
  return { roman: keep(roman).filter((k) => /^[a-z0-9]+$/.test(k)), dev: keep(dev) }
}
