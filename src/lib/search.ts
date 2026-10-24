import type { SearchResult, Transcript } from '@/types'

/**
 * "Find the moment" search. Works on Hindi, Hinglish and English at once:
 * a query can be Roman or Devanagari, and a few topic synonyms bridge the two
 * ("investor" finds "इन्वेस्टर", "paisa" finds "funding"). Runs against the transcript,
 * so results are timestamps with the matched sentence, ready to become clips.
 */

const STOP = new Set(
  (
    'where i talk talked talks about the a an is are to of in on at my me when what which find show part moment clip ' +
    'for with and or that this it we you your do did does jahan jaha kahan kab main maine mein ne ka ki ke ko se par ' +
    'hai hain tha thi baat baare bare wala wali wo woh ye yeh aur mera meri mere kar karte karta karti kiya kiye ' +
    'bola bataya batao dhoondo dikhao dikha mujhe bata bol raha rahi'
  ).split(' '),
)

const GROUPS: string[][] = [
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

const groupOf = new Map<string, number>()
GROUPS.forEach((g, i) => g.forEach((w) => groupOf.set(w.toLowerCase(), i)))

const TOKEN = /[\p{L}\p{M}\p{N}]+/gu

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(TOKEN) ?? []).filter(Boolean)
}

export function queryTokens(q: string): string[] {
  return tokenize(q).filter((t) => !STOP.has(t))
}

function editDistanceAtMostOne(a: string, b: string): boolean {
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

/** 0 = no match, otherwise a weight between 0.5 and 1. */
export function matchWeight(q: string, word: string): number {
  if (q === word) return 1
  if (q.length >= 3 && word.startsWith(q)) return 0.78
  if (word.length >= 4 && q.startsWith(word) && q.length - word.length <= 2) return 0.7
  const gq = groupOf.get(q)
  if (gq !== undefined && gq === groupOf.get(word)) return 0.62
  if (q.length >= 5 && word.length >= 5 && editDistanceAtMostOne(q, word)) return 0.55
  return 0
}

export function searchTranscript(tr: Transcript, query: string, limit = 8): SearchResult[] {
  const qs = queryTokens(query)
  if (!qs.length) return []

  interface Hit {
    si: number
    score: number
    matched: number[]
  }
  const hits: Hit[] = []
  tr.sentences.forEach((s, si) => {
    let total = 0
    const matched: number[] = []
    for (const q of qs) {
      let best = 0
      let bestIdx = -1
      for (let i = s.from; i < s.to; i++) {
        const w = tr.words[i]!
        const weight = Math.max(
          matchWeight(q, tokenize(w.text).join('')),
          matchWeight(q, tokenize(w.dev).join('')),
        )
        if (weight > best) {
          best = weight
          bestIdx = i
        }
      }
      total += best
      if (bestIdx >= 0 && best > 0) matched.push(bestIdx)
    }
    const score = total / qs.length
    if (score >= 0.45) hits.push({ si, score, matched })
  })

  hits.sort((a, b) => b.score - a.score || a.si - b.si)
  const results: SearchResult[] = []
  const used: Array<[number, number]> = []
  for (const h of hits) {
    const s = tr.sentences[h.si]!
    // Short sentences make weak clips: pull in the next one for context.
    let lastIdx = h.si
    if (s.end - s.start < 7 && tr.sentences[h.si + 1]) lastIdx = h.si + 1
    const last = tr.sentences[lastIdx]!
    const start = Math.max(0, s.start - 0.3)
    const end = last.end + 0.4
    if (used.some(([a, b]) => start < b && end > a)) continue
    used.push([start, end])
    results.push({
      id: `sr_${h.si}`,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      relevance: Math.max(
        40,
        Math.min(99, Math.round(h.score * 90 + Math.min(h.matched.length, 3) * 3)),
      ),
      matched: [...new Set(h.matched)].sort((a, b) => a - b),
      from: s.from,
      to: last.to,
      thumbSeed: `search-${h.si}`,
    })
    if (results.length >= limit) break
  }
  return results.sort((a, b) => b.relevance - a.relevance)
}
