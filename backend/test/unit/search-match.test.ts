import { describe, expect, it } from 'vitest'
import { groupMembers, groupOf, tokenize } from '../../src/modules/search/groups.js'
import {
  assembleResults,
  candidateForms,
  keyWeight,
  matchWeight,
  queryTerms,
  searchInMemory,
  type MatchWord,
  type SentenceRow,
} from '../../src/modules/search/match.js'
import { fixtureTranscript } from '../helpers/transcript-fixture.js'

const fx = fixtureTranscript()
const sentences: SentenceRow[] = fx.transcript.sentences.map((s) => ({
  idx: s.idx,
  from: s.from,
  to: s.to,
  start: s.start,
  end: s.end,
}))
const words: MatchWord[] = fx.transcript.words.map((w) => ({ norm: w.norm, dev: w.dev }))
const search = (q: string, limit?: number) => searchInMemory(sentences, words, q, limit)
const textOf = (r: { from: number; to: number }) =>
  fx.transcript.words
    .slice(r.from, r.to)
    .map((w) => `${w.text} ${w.dev}`)
    .join(' ')
    .toLowerCase()

describe('reading a query', () => {
  it('drops filler words from a natural-language query', () => {
    expect(queryTerms('where I talk about funding').map((t) => t.raw)).toEqual(['funding'])
    expect(queryTerms('jahan maine galti ki baat ki').map((t) => t.raw)).toEqual(['galti'])
  })

  it('reads Roman and Devanagari to the same key', () => {
    const [roman] = queryTerms('funding')
    const [dev] = queryTerms('फंडिंग')
    expect(dev!.key).toBe(roman!.key)
    expect(roman!.dev).toBe('फंडिंग')
    expect(dev!.dev).toBe('फंडिंग')
  })

  it('folds spelling variants into one key', () => {
    expect(queryTerms('phunding')[0]!.key).toBe(queryTerms('funding')[0]!.key)
    expect(queryTerms('zyada')[0]!.key).toBe(queryTerms('jyada')[0]!.key)
  })

  it('puts topic words in their group, in either script', () => {
    expect(groupOf('investor')).toBeDefined()
    expect(groupOf('इन्वेस्टर')).toBe(groupOf('investor'))
    expect(groupOf('paisa')).toBe(groupOf('funding'))
    expect(groupOf('table')).toBeUndefined()
  })

  it('nothing to look for gives no terms', () => {
    expect(queryTerms('')).toEqual([])
    expect(queryTerms('   ')).toEqual([])
    expect(queryTerms('where I talk about the')).toEqual([])
    expect(queryTerms('!!! ??? ...')).toEqual([])
  })

  it('tokenises Roman and Devanagari, ignoring punctuation', () => {
    expect(tokenize('Funding, फंडिंग! 40-lakh')).toEqual(['funding', 'फंडिंग', '40', 'lakh'])
  })
})

describe('how well a word matches', () => {
  const w = (norm: string, dev = norm): MatchWord => ({ norm, dev })

  it('exact is 1, then prefix, then a longer query, then one typo', () => {
    expect(keyWeight('funding', 'funding')).toBe(1)
    expect(keyWeight('fund', 'funding')).toBe(0.78)
    expect(keyWeight('fundings', 'funding')).toBe(0.7)
    expect(keyWeight('investar', 'investor')).toBe(0.55)
    expect(keyWeight('cat', 'cut')).toBe(0)
    expect(keyWeight('', 'x')).toBe(0)
  })

  it('a one letter typo only counts on longer words', () => {
    expect(keyWeight('cat', 'cut')).toBe(0)
    expect(keyWeight('table', 'cable')).toBe(0.55)
  })

  it('a spelling variant is as good as the exact word, because both are folded', () => {
    const [funding] = queryTerms('funding')
    expect(matchWeight(funding!, w(queryTerms('phunding')[0]!.key))).toBe(1)
  })

  it('a topic synonym matches, below an exact match', () => {
    const [paisa] = queryTerms('paisa')
    expect(matchWeight(paisa!, w(queryTerms('funding')[0]!.key, 'फंडिंग'))).toBe(0.62)
    expect(matchWeight(paisa!, w('table'))).toBe(0)
  })

  it('a Devanagari query matches the stored Devanagari spelling directly', () => {
    const [q] = queryTerms('फंडिंग')
    expect(matchWeight(q!, w('zzz', 'फंडिंग,'))).toBe(1)
  })
})

describe('finding moments', () => {
  it('finds funding in Roman, Devanagari and sentence form', () => {
    for (const q of ['funding', 'फंडिंग', 'where I talk about funding', 'funding wala hissa']) {
      const res = search(q)
      expect(res.length, q).toBeGreaterThan(1)
      expect(textOf(res[0]!), q).toMatch(/funding|फंडिंग|investor|raise|paisa|पैसा/)
    }
  })

  it('finds the mistake story through topic synonyms', () => {
    const res = search('where I talk about my mistake')
    expect(textOf(res[0]!)).toMatch(/galti|गलती|mistake/)
  })

  it('an English word finds the sentence written in Devanagari, and the reverse', () => {
    expect(textOf(search('term sheet')[0]!)).toContain('टर्म')
    expect(textOf(search('टर्म शीट')[0]!)).toMatch(/term|टर्म/)
    expect(textOf(search('investors')[0]!)).toMatch(/इन्वेस्टर/)
    expect(textOf(search('इन्वेस्टर्स')[0]!)).toMatch(/investor|इन्वेस्टर/)
  })

  it('a misspelling still finds it', () => {
    expect(search('phunding').length).toBeGreaterThan(1)
    // One letter wrong on a word of five or more letters: "raisse" for "raise".
    expect(textOf(search('raisse')[0]!)).toMatch(/रेज़|raise/)
    expect(textOf(search('bootstraping')[0]!)).toMatch(/बूटस्ट्रैपिंग|bootstrap/)
  })

  it('a synonym finds a related moment: "paisa" reaches the funding talk', () => {
    expect(search('paisa').length).toBeGreaterThan(1)
  })

  it('returns timestamps, a relevance score from 40 to 99, and the matched words', () => {
    const [top] = search('term sheet')
    expect(top!.end).toBeGreaterThan(top!.start)
    expect(top!.relevance).toBeGreaterThanOrEqual(70)
    expect(top!.relevance).toBeLessThanOrEqual(99)
    expect(top!.matched.length).toBeGreaterThan(0)
    for (const m of top!.matched) {
      expect(m).toBeGreaterThanOrEqual(top!.from)
      expect(m).toBeLessThan(top!.to)
    }
    for (const r of search('funding')) {
      expect(r.relevance).toBeGreaterThanOrEqual(40)
      expect(r.relevance).toBeLessThanOrEqual(99)
    }
  })

  it('never returns overlapping clips, and is sorted best first', () => {
    for (const q of ['funding', 'investor', 'paisa', 'pitch deck']) {
      const res = search(q)
      for (let i = 1; i < res.length; i++)
        expect(res[i]!.relevance).toBeLessThanOrEqual(res[i - 1]!.relevance)
      for (const a of res)
        for (const b of res) if (a !== b) expect(a.start < b.end && a.end > b.start, q).toBe(false)
    }
  })

  it('respects the limit', () => {
    expect(search('funding', 1)).toHaveLength(1)
    expect(search('funding', 2).length).toBeLessThanOrEqual(2)
  })

  it('returns nothing for nonsense, an empty query or only filler words', () => {
    expect(search('zzxqv')).toEqual([])
    expect(search('   ')).toEqual([])
    expect(search('where I talk about the')).toEqual([])
  })

  it('a clip is never empty or inverted, and starts a little before the sentence', () => {
    for (const r of search('funding')) {
      expect(r.start).toBeGreaterThanOrEqual(0)
      expect(r.end).toBeGreaterThan(r.start)
      expect(r.to).toBeGreaterThan(r.from)
    }
  })

  it('widens a short sentence with the one after it, for context', () => {
    // "और आपकी पहली गलती क्या थी?" is short; the clip should reach into the answer.
    const [top] = search('galti')
    const own = sentences[Number(top!.id.slice(3))]!
    expect(own.end - own.start).toBeLessThan(7)
    expect(top!.to).toBeGreaterThan(own.to)
  })

  it('ids and thumbnail seeds follow the sentence the clip starts at', () => {
    const [top] = search('term sheet')
    expect(top!.id).toMatch(/^sr_\d+$/)
    expect(top!.thumbSeed).toBe(`search-${top!.id.slice(3)}`)
  })
})

describe('assembling results', () => {
  const row = (idx: number, start: number, end: number): SentenceRow => ({
    idx,
    from: idx * 3,
    to: idx * 3 + 3,
    start,
    end,
  })

  it('skips a result that overlaps a better one', () => {
    const hits = [
      { sentence: row(0, 0, 10), score: 0.9, matched: [0] },
      { sentence: row(1, 10.2, 20), score: 0.8, matched: [3] },
      { sentence: row(2, 40, 50), score: 0.7, matched: [6] },
    ]
    // Hit 1 starts 0.3 s before 10.2, inside hit 0's padded end (10.4), so it is dropped.
    const out = assembleResults(hits, () => undefined, 8)
    expect(out.map((r) => r.id)).toEqual(['sr_0', 'sr_2'])
  })

  it('keeps relevance between 40 and 99', () => {
    const hits = [
      { sentence: row(0, 0, 10), score: 1, matched: [0, 1, 2, 3, 4] },
      { sentence: row(1, 30, 40), score: 0.1, matched: [] },
    ]
    const out = assembleResults(hits, () => undefined, 8)
    expect(out.map((r) => r.relevance)).toEqual([99, 40])
  })

  it('deduplicates matched indices and sorts them', () => {
    const out = assembleResults(
      [{ sentence: row(0, 0, 10), score: 0.9, matched: [2, 1, 2] }],
      () => undefined,
      8,
    )
    expect(out[0]!.matched).toEqual([1, 2])
  })
})

describe('what the database is asked for', () => {
  it('Roman forms are plain a-z0-9, safe to put in a text-search query whatever was typed', () => {
    for (const q of [
      "funding'; drop table x; --",
      'a & b | c',
      'what:*',
      '(((',
      'फंडिंग',
      'funding%_\\',
    ]) {
      for (const k of candidateForms(queryTerms(q)).roman) expect(k, q).toMatch(/^[a-z0-9]+$/)
    }
  })

  it('includes every member of a topic group, in both scripts', () => {
    const forms = candidateForms(queryTerms('paisa'))
    expect(forms.roman).toEqual(expect.arrayContaining(['funding', 'investor', 'raise']))
    expect(forms.dev).toEqual(expect.arrayContaining(['फंडिंग', 'पैसा']))
    expect(groupMembers(groupOf('paisa')!).roman).toContain('funding')
  })

  it('has nothing to ask for when there is no query', () => {
    expect(candidateForms([])).toEqual({ roman: [], dev: [] })
  })
})
