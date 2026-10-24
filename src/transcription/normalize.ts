import type { SpeakerRow } from '../db/schema/transcripts.js'
import type { Lang } from '../modules/account/schema.js'
import { isAmbiguousRoman, isEnglishDevanagari, isFillerWord, isHindiRoman } from './lexicon.js'
import { foldForSearch } from './fold.js'
import { devanagariToRoman, hasDevanagari, hasLatin, romanToDevanagari } from './translit.js'
import type { RawTranscript, RawWord } from './types.js'

/** A word in the shape the front end's transcript uses, plus the extra fields search needs. */
export interface BuiltWord {
  /** Roman (Hinglish) spelling. English words keep their English spelling. */
  text: string
  /** Devanagari spelling, shown in Devanagari mode. Equals `text` for a word we cannot spell in Devanagari. */
  dev: string
  /** Lower-case, punctuation-free Roman form, for search. */
  norm: string
  start: number
  end: number
  speaker: string
  confidence: number | null
  language: 'hi' | 'en'
  filler: boolean
}

export interface BuiltSentence {
  idx: number
  speaker: string
  /** First word (inclusive) and one past the last word (exclusive), as the front end expects. */
  from: number
  to: number
  start: number
  end: number
  text: string
  dev: string
  norm: string
}

export interface BuiltTranscript {
  language: Lang
  speakers: SpeakerRow[]
  words: BuiltWord[]
  sentences: BuiltSentence[]
}

export interface NormalizeOptions {
  /** What the user said they speak; the answer when there is too little to tell. */
  hint?: Lang
  /** A silence at least this long between words starts a new sentence. */
  pauseSec?: number
  /** A sentence never runs longer than this many words. */
  maxSentenceWords?: number
}

/** Sound and music tags that recognisers sometimes emit as if they were words. */
const NOISE_TAG = /^[[(<*♪♫].*[\])>*♪♫]$|^[♪♫]+$/
const SENTENCE_END = /[.?!।॥…]["'”’)\]]*$/
const WRAPPERS = /^([("'“‘[]*)(.*?)([.,!?;:।॥…"'”’)\]-]*)$/su

const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Turns a provider's flat word list into the editor's transcript: both scripts for every word, each word
 * marked Hindi or English (so a mixed sentence renders correctly), fillers flagged, speakers numbered, and
 * words grouped into sentences. What was spoken is never rewritten, only given a second spelling.
 */
export function buildTranscript(raw: RawTranscript, opts: NormalizeOptions = {}): BuiltTranscript {
  const speakerIds = new Map<string, string>()
  const idFor = (label: string | undefined) => {
    const key = label ?? '_'
    let id = speakerIds.get(key)
    if (!id) speakerIds.set(key, (id = `S${speakerIds.size + 1}`))
    return id
  }

  const words: BuiltWord[] = []
  let lastEnd = 0
  let lastStart = 0

  for (const w of raw.words) {
    const token = clean(w.text)
    if (!token || NOISE_TAG.test(token)) continue
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue

    const parts = WRAPPERS.exec(token)
    const lead = parts?.[1] ?? ''
    const core = parts?.[2] ?? token
    const trail = parts?.[3] ?? ''

    // A token that is only punctuation belongs to the word before it.
    if (!core) {
      const prev = words[words.length - 1]
      if (prev) {
        prev.text += asRomanPunct(trail)
        prev.dev += trail
      }
      continue
    }

    // Times must run forward. Providers occasionally report a word that starts before the last one ended.
    const start = Math.max(w.start, lastStart, 0)
    const end = Math.max(w.end, start + 0.01, 0)
    lastStart = start
    lastEnd = Math.max(lastEnd, end)

    const built = spell(lead, core, trail, words[words.length - 1]?.language)
    words.push({
      ...built,
      start: round(start),
      end: round(end),
      speaker: idFor(w.speaker),
      confidence: w.confidence !== undefined && Number.isFinite(w.confidence) ? w.confidence : null,
    })
  }

  const speakers = speakerRows(speakerIds, words.length === 0)
  const sentences = buildSentences(words, opts)
  return { language: classify(words, raw, opts.hint), speakers, words, sentences }
}

/** Both spellings, the word's language, and whether it is a filler. */
function spell(
  lead: string,
  core: string,
  trail: string,
  previousLanguage?: 'hi' | 'en',
): Pick<BuiltWord, 'text' | 'dev' | 'norm' | 'language' | 'filler'> {
  if (hasDevanagari(core)) {
    const roman = devanagariToRoman(core).toLowerCase()
    return {
      text: lead + roman + asRomanPunct(trail),
      dev: lead + core + trail,
      norm: foldForSearch(roman),
      language: isEnglishDevanagari(core) ? 'en' : 'hi',
      filler: isFillerWord(roman),
    }
  }
  if (hasLatin(core)) {
    const dev = romanToDevanagari(core)
    return {
      text: lead + core + trail,
      dev: lead + dev + trail,
      norm: foldForSearch(core),
      // An ambiguous word ("the", "is", "main") takes the language of the word before it.
      language: isAmbiguousRoman(core)
        ? (previousLanguage ?? 'en')
        : isHindiRoman(core)
          ? 'hi'
          : 'en',
      filler: isFillerWord(core),
    }
  }
  // Numbers and symbols read the same in both scripts and take the language around them.
  return {
    text: lead + core + trail,
    dev: lead + core + trail,
    norm: foldForSearch(core),
    language: previousLanguage ?? 'en',
    filler: false,
  }
}

const clean = (s: string) => s.replace(/[\u200b-\u200d\ufeff]/g, '').trim()

/** "।" is the Devanagari full stop; the Roman column uses a plain ".". */
const asRomanPunct = (p: string) => p.replace(/[।॥]/g, '.')

function speakerRows(ids: Map<string, string>, empty: boolean): SpeakerRow[] {
  const colors: SpeakerRow['color'][] = ['saffron', 'teal']
  const list = [...ids.values()]
  if (!list.length && !empty) list.push('S1')
  if (!list.length) list.push('S1')
  return list.map((id, i) => ({
    id,
    name: `Speaker ${i + 1}`,
    color: colors[i % colors.length]!,
  }))
}

function buildSentences(words: BuiltWord[], opts: NormalizeOptions): BuiltSentence[] {
  const pause = opts.pauseSec ?? 1.2
  const maxWords = opts.maxSentenceWords ?? 40
  const out: BuiltSentence[] = []
  let from = 0

  const close = (to: number) => {
    if (to <= from) return
    const slice = words.slice(from, to)
    out.push({
      idx: out.length,
      speaker: slice[0]!.speaker,
      from,
      to,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      text: slice.map((w) => w.text).join(' '),
      dev: slice.map((w) => w.dev).join(' '),
      norm: slice.map((w) => w.norm).join(' '),
    })
    from = to
  }

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!
    const cur = words[i]!
    if (
      SENTENCE_END.test(prev.text) ||
      cur.speaker !== prev.speaker ||
      cur.start - prev.end > pause ||
      i - from >= maxWords
    ) {
      close(i)
    }
  }
  close(words.length)
  return out
}

/**
 * Hindi, English or Hinglish, judged by the share of English words (including English written in
 * Devanagari). Mostly one language wins; a real mix is Hinglish. With almost nothing said, trust the hint.
 */
function classify(words: BuiltWord[], raw: RawTranscript, hint?: Lang): Lang {
  const countable = words.filter((w) => /[a-z\p{Script=Devanagari}]/iu.test(w.norm))
  if (countable.length < 5) return hint ?? (raw.language === 'en' ? 'en' : 'hinglish')
  const share = countable.filter((w) => w.language === 'en').length / countable.length
  if (share < 0.1) return 'hi'
  if (share > 0.9) return 'en'
  return 'hinglish'
}

export { foldForSearch }
export type { RawWord }
