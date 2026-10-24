import { foldForSearch } from '../../transcription/fold.js'
import { knownRoman } from '../../transcription/lexicon.js'
import { devanagariToRoman, hasDevanagari } from '../../transcription/translit.js'

/**
 * Topic synonyms that bridge Roman and Devanagari ("investor" finds "इन्वेस्टर", "paisa" finds "funding"). Ported
 * from the front end (src/lib/search.ts) so the server ranks the way the editor always has. A word in any group
 * matches a query word from the same group, at a lower weight than an exact match.
 */
export const GROUPS: string[][] = [
  [
    'funding',
    'फंडिंग',
    'invest',
    'investor',
    'investors',
    'इन्वेस्टर',
    'इन्वेस्टर्स',
    'raise',
    'रेज़',
    'paisa',
    'पैसा',
    'paise',
    'पैसे',
    'capital',
    'round',
    'राउंड',
    'crore',
    'करोड़',
  ],
  [
    'galti',
    'गलती',
    'mistake',
    'मिस्टेक',
    'galat',
    'ग़लत',
    'nuksaan',
    'नुकसान',
    'lakh',
    'लाख',
    'kharch',
    'खर्च',
  ],
  ['team', 'टीम', 'hire', 'हायर', 'hiring', 'culture', 'कल्चर', 'naukri', 'नौकरी'],
  ['pitch', 'पिच', 'deck', 'डेक', 'slides', 'स्लाइड्स', 'presentation', 'traction', 'ट्रैक्शन'],
  [
    'legal',
    'लीगल',
    'lawyer',
    'लॉयर',
    'clause',
    'क्लॉज़',
    'term',
    'टर्म',
    'sheet',
    'शीट',
    'contract',
  ],
  [
    'reels',
    'रील्स',
    'instagram',
    'इंस्टाग्राम',
    'social',
    'सोशल',
    'media',
    'मीडिया',
    'video',
    'वीडियो',
    'brand',
    'ब्रांड',
    'visibility',
    'विज़िबिलिटी',
  ],
  [
    'bootstrapping',
    'बूटस्ट्रैपिंग',
    'bootstrap',
    'cash',
    'कैश',
    'flow',
    'फ़्लो',
    'revenue',
    'रेवेन्यू',
    'profit',
  ],
  ['darr', 'डर', 'payroll', 'पेरोल', 'raatein', 'रातें', 'fear', 'ro', 'रो', 'emotional'],
  ['salah', 'सलाह', 'advice', 'tips', 'founders', 'फाउंडर्स', 'founder'],
  ['valuation', 'वैल्यूएशन', 'number', 'नंबर', 'kahani', 'कहानी', 'story'],
  [
    'product',
    'प्रोडक्ट',
    'retention',
    'रिटेंशन',
    'fit',
    'फ़िट',
    'customers',
    'कस्टमर्स',
    'customer',
  ],
]

const TOKEN = /[\p{L}\p{M}\p{N}]+/gu

/** Lower-cased runs of letters, marks and digits. Works on Roman and Devanagari alike. */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(TOKEN) ?? []).filter(Boolean)
}

/**
 * The key a word is stored under and looked up by. Roman is folded (so spelling variants meet); Devanagari is
 * compared as written, and also mapped to its Roman spelling, since stored words are keyed by their Roman form.
 */
function keysOf(token: string): string[] {
  if (!hasDevanagari(token)) return [foldForSearch(token)]
  const roman = knownRoman(token) ?? devanagariToRoman(token)
  return [token, foldForSearch(roman)]
}

const groupByKey = new Map<string, number>()
GROUPS.forEach((group, i) => {
  for (const word of group)
    for (const key of keysOf(tokenize(word).join(''))) groupByKey.set(key, i)
})

/** Which topic group a word belongs to, if any. */
export function groupOf(token: string): number | undefined {
  for (const key of keysOf(tokenize(token).join(''))) {
    const g = groupByKey.get(key)
    if (g !== undefined) return g
  }
  return undefined
}

/** Every Roman key (folded) and every Devanagari word in a group: what to look for when a query word belongs to it. */
export function groupMembers(group: number): { roman: string[]; dev: string[] } {
  const roman = new Set<string>()
  const dev = new Set<string>()
  for (const word of GROUPS[group] ?? []) {
    if (hasDevanagari(word)) dev.add(tokenize(word).join(''))
    else roman.add(foldForSearch(word))
  }
  return { roman: [...roman], dev: [...dev] }
}
