import { describe, expect, it } from 'vitest'
import { generateSource } from '@/mocks/data/seed'
import { matchWeight, queryTokens, searchTranscript } from './search'

const { transcript: tr } = generateSource('p_funding', 0, 56)
const textOf = (r: { from: number; to: number }) =>
  tr.words
    .slice(r.from, r.to)
    .map((w) => w.text)
    .join(' ')
    .toLowerCase()

describe('find-the-moment search', () => {
  it('drops filler words from a natural-language query', () => {
    expect(queryTokens('where I talk about funding')).toEqual(['funding'])
    expect(queryTokens('jahan maine galti ki baat ki')).toEqual(['galti'])
  })

  it('finds funding in Roman, Devanagari and sentence form', () => {
    for (const q of ['funding', 'फंडिंग', 'where I talk about funding', 'funding wala hissa']) {
      const res = searchTranscript(tr, q)
      expect(res.length, q).toBeGreaterThan(2)
      expect(textOf(res[0]!), q).toMatch(/funding|investor|raise|paisa/)
    }
  })

  it('finds the mistake story with topic synonyms', () => {
    const res = searchTranscript(tr, 'where I talk about my biggest mistake')
    expect(textOf(res[0]!)).toMatch(/galti|mistake/)
  })

  it('returns timestamps, a relevance score and the matched words', () => {
    const [top] = searchTranscript(tr, 'term sheet')
    expect(top!.end).toBeGreaterThan(top!.start)
    expect(top!.relevance).toBeGreaterThanOrEqual(70)
    expect(top!.matched.length).toBeGreaterThan(0)
    expect(textOf(top!)).toContain('term')
  })

  it('does not return overlapping clips and is sorted by relevance', () => {
    const res = searchTranscript(tr, 'investor')
    for (let i = 1; i < res.length; i++)
      expect(res[i]!.relevance).toBeLessThanOrEqual(res[i - 1]!.relevance)
    for (const a of res)
      for (const b of res) if (a !== b) expect(a.start < b.end && a.end > b.start).toBe(false)
  })

  it('returns nothing for nonsense or an empty query', () => {
    expect(searchTranscript(tr, 'zzxqv')).toEqual([])
    expect(searchTranscript(tr, '   ')).toEqual([])
  })

  it('tolerates a one-letter typo on longer words', () => {
    expect(matchWeight('investar', 'investor')).toBeGreaterThan(0)
    expect(matchWeight('cat', 'cut')).toBe(0)
  })
})
