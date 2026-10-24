import { knownDevanagari, knownRoman } from './lexicon.js'

/**
 * Moving a word between Devanagari and Roman. Known words come from the lexicon (so फंडिंग is
 * "funding" and नहीं is "nahi"); everything else goes through rules. Rule output is a reasonable
 * phonetic spelling, not a dictionary one, which is exactly what Hinglish typing looks like.
 */

const VIRAMA = '्' // ्
const NUKTA = '़' // ़
const ANUSVARA = 'ं' // ं
const CHANDRABINDU = 'ँ' // ँ
const VISARGA = 'ः' // ः

export const hasDevanagari = (s: string): boolean => /[\u0900-\u097f]/.test(s)
export const hasLatin = (s: string): boolean => /[A-Za-z]/.test(s)

/* ----------------------------- Devanagari -> Roman ----------------------------- */

const CONSONANTS: Record<string, string> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'n',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
  क्ष: 'ksh',
  त्र: 'tr',
  ज्ञ: 'gy',
  ळ: 'l',
}

/** Consonant + nukta: borrowed sounds. */
const NUKTA_FORMS: Record<string, string> = {
  क: 'q',
  ख: 'kh',
  ग: 'g',
  ज: 'z',
  ड: 'r',
  ढ: 'dh',
  फ: 'f',
}

const INDEPENDENT_VOWELS: Record<string, string> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ee',
  उ: 'u',
  ऊ: 'oo',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऑ: 'o',
}

const MATRAS: Record<string, string> = {
  'ा': 'a',
  'ि': 'i',
  'ी': 'ee',
  'ु': 'u',
  'ू': 'oo',
  'ृ': 'ri',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
  'ॉ': 'o',
  'ॅ': 'e',
}

const DIGITS: Record<string, string> = {
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
}

interface Unit {
  /** Roman for this consonant or vowel. */
  roman: string
  /** A consonant with the inherent 'a' still attached (a candidate for schwa deletion). */
  schwa: boolean
  consonant: boolean
}

export function devanagariToRoman(word: string): string {
  const known = knownRoman(word)
  if (known) return known
  return rulesToRoman(word)
}

function rulesToRoman(word: string): string {
  const chars = [...word.normalize('NFC')]
  const units: Unit[] = []
  let i = 0
  const push = (u: Unit) => units.push(u)

  while (i < chars.length) {
    const c = chars[i]!
    if (c in DIGITS) {
      push({ roman: DIGITS[c]!, schwa: false, consonant: false })
      i++
    } else if (c in INDEPENDENT_VOWELS) {
      push({ roman: INDEPENDENT_VOWELS[c]!, schwa: false, consonant: false })
      i++
    } else if (c in CONSONANTS || c in NUKTA_FORMS) {
      let roman = CONSONANTS[c] ?? ''
      i++
      if (chars[i] === NUKTA) {
        roman = NUKTA_FORMS[c] ?? roman
        i++
      }
      const next = chars[i]
      if (next === VIRAMA) {
        // A conjunct: the consonant carries no vowel of its own.
        push({ roman, schwa: false, consonant: true })
        i++
      } else if (next && next in MATRAS) {
        push({ roman: roman + MATRAS[next], schwa: false, consonant: true })
        i++
      } else {
        push({ roman, schwa: true, consonant: true })
      }
    } else if (c === ANUSVARA || c === CHANDRABINDU) {
      // m before a lip sound (p, ph, b, bh, m), otherwise n.
      const nextCons = chars[i + 1]
      const lips = nextCons !== undefined && 'पफबभम'.includes(nextCons)
      push({ roman: lips && c === ANUSVARA ? 'm' : 'n', schwa: false, consonant: false })
      i++
    } else if (c === VISARGA) {
      push({ roman: 'h', schwa: false, consonant: false })
      i++
    } else if (c === '।' || c === '॥') {
      push({ roman: '.', schwa: false, consonant: false })
      i++
    } else if (c === NUKTA || c === VIRAMA) {
      i++
    } else if (c === 'ॐ') {
      push({ roman: 'om', schwa: false, consonant: false })
      i++
    } else if (c >= '\u0900' && c <= '\u097F') {
      // A Devanagari mark we have no Roman for (an accent, a rare sign): leave it out.
      i++
    } else {
      push({ roman: c, schwa: false, consonant: false })
      i++
    }
  }

  // Hindi drops the inherent 'a' at the end of a word, and inside a word when it sits between
  // two sounded syllables (समझना is "samajhna", not "samajahana"). Walk from the right so the
  // syllable after is already settled.
  const sounded = (u: Unit | undefined) =>
    u !== undefined && (!u.consonant || u.schwa || /[aeiou]/.test(u.roman))
  for (let n = units.length - 1; n >= 0; n--) {
    const u = units[n]!
    if (!u.schwa) continue
    const isLast =
      n === units.length - 1 ||
      units.slice(n + 1).every((x) => !x.consonant && !/[aeiou]/.test(x.roman))
    if (isLast && n > 0) {
      u.schwa = false
      continue
    }
    const prev = units[n - 1]
    const next = units[n + 1]
    if (n > 0 && next?.consonant && sounded(prev) && (next.schwa || /[aeiou]/.test(next.roman))) {
      u.schwa = false
    }
  }

  const roman = units.map((u) => (u.schwa ? u.roman + 'a' : u.roman)).join('')
  // Hinglish spelling habits: "padhai", not "padhaee"; and a final long ee is written i ("khushi").
  return roman.replace(/aee/g, 'ai').replace(/(?<=[a-z]{2})ee$/, 'i')
}

/* ----------------------------- Roman -> Devanagari ----------------------------- */

/**
 * Devanagari for a Roman word, only when the lexicon knows it. Rules for this direction would be
 * guesses ("kitab" could be किताब or कितब, and an English word like "school" has no rule-derivable
 * Devanagari at all), and a wrong spelling is worse than none, so an unknown word comes back unchanged
 * and is shown in Roman in Devanagari mode. A language-model pass can fill the gaps in a later phase.
 */
export function romanToDevanagari(word: string): string {
  return knownDevanagari(word) ?? word
}
