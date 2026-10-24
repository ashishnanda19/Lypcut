import { describe, expect, it } from 'vitest'
import { buildProfile, confidenceOf, type ReelFacts } from '../../src/style/analysis/profile.js'
import { selectWinners } from '../../src/style/analysis/winners.js'

let n = 0
const facts = (over: Partial<ReelFacts> = {}): ReelFacts => ({
  id: `r${++n}`,
  at: new Date(2026, 8, n),
  hookTimingSec: 1.5,
  cutPace: 3,
  durationSec: 30,
  captionStyleId: 'saffron-pop',
  fonts: ['Inter'],
  colors: ['#ffa83a'],
  skipRate: null,
  hasMetrics: true,
  ...over,
})
const equal = (reels: ReelFacts[]) => ({
  winners: reels.map((r) => ({ id: r.id, weight: 1 / reels.length })),
  ranked: true,
})

describe('building the profile', () => {
  it('averages timing and cut pace over the winners, by weight', () => {
    const a = facts({ hookTimingSec: 1, cutPace: 2 })
    const b = facts({ hookTimingSec: 3, cutPace: 4 })
    const p = buildProfile([a, b], {
      winners: [
        { id: a.id, weight: 0.75 },
        { id: b.id, weight: 0.25 },
      ],
      ranked: true,
    })
    expect(p.hookTimingSec).toBe(1.5)
    expect(p.cutPace).toBe(2.5)
  })

  it('is learned from the winners only: a Reel that did not win changes nothing', () => {
    const win = [facts({ cutPace: 2 }), facts({ cutPace: 2 }), facts({ cutPace: 2 })]
    const loser = facts({ cutPace: 9, captionStyleId: 'boxed' })
    const p = buildProfile([...win, loser], equal(win))
    expect(p.cutPace).toBe(2)
    expect(p.captionStyles).toEqual([{ id: 'saffron-pop', share: 1 }])
    expect(p.reelsAnalysed).toBe(4)
  })

  it('lists caption styles with shares that add up to 1, biggest first', () => {
    const reels = [
      ...Array.from({ length: 3 }, () => facts({ captionStyleId: 'saffron-pop' })),
      ...Array.from({ length: 2 }, () => facts({ captionStyleId: 'boxed' })),
      facts({ captionStyleId: 'karaoke' }),
      facts({ captionStyleId: 'custom' }),
    ]
    const p = buildProfile(reels, equal(reels))
    expect(p.captionStyles.map((c) => c.id)).toEqual(['saffron-pop', 'boxed', 'custom', 'karaoke'])
    expect(p.captionStyles.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 10)
    expect(p.captionStyles[0]!.share).toBeGreaterThan(p.captionStyles[1]!.share)
  })

  it('keeps the shares at exactly 1 when thirds do not divide evenly', () => {
    const reels = ['saffron-pop', 'boxed', 'karaoke'].map((s) => facts({ captionStyleId: s }))
    const p = buildProfile(reels, equal(reels))
    expect(p.captionStyles.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 10)
  })

  it('has no caption styles when no winner had captions, and does not count a Reel with none', () => {
    const none = [facts({ captionStyleId: null }), facts({ captionStyleId: null })]
    expect(buildProfile(none, equal(none)).captionStyles).toEqual([])
    const mixed = [facts({ captionStyleId: null }), facts({ captionStyleId: 'boxed' })]
    expect(buildProfile(mixed, equal(mixed)).captionStyles).toEqual([{ id: 'boxed', share: 1 }])
  })

  it('has no music, always: music is not learned in this version', () => {
    expect(buildProfile([facts()], equal([facts()])).music).toEqual([])
  })

  it('takes hook retention from Instagram’s skip rate for the last eight Reels, oldest first, and is empty without it', () => {
    const reels = Array.from({ length: 10 }, (_, i) =>
      facts({ at: new Date(2026, 5, i + 1), skipRate: i / 10 }),
    )
    const p = buildProfile(reels, equal(reels))
    expect(p.hookRetention).toEqual([80, 70, 60, 50, 40, 30, 20, 10])
    const none = [facts(), facts()]
    expect(buildProfile(none, equal(none)).hookRetention).toEqual([])
  })

  it('names the fonts and colours the winners used most, within the limits', () => {
    const reels = [
      facts({ fonts: ['Inter'], colors: ['#ffa83a', '#ffffff'] }),
      facts({ fonts: ['Inter', 'Noto Sans Devanagari'], colors: ['#ffa83a'] }),
      facts({
        fonts: ['Noto Sans Devanagari'],
        colors: ['#5fcdbb', '#ff7a5c', '#ffe14a', '#123456'],
      }),
    ]
    const p = buildProfile(reels, equal(reels))
    expect(p.fonts).toEqual(['Inter', 'Noto Sans Devanagari'])
    expect(p.colors[0]).toBe('#ffa83a')
    expect(p.colors.length).toBeLessThanOrEqual(4)
  })

  it('does not break with no winners or no hook timing found', () => {
    const p = buildProfile([], { winners: [], ranked: false })
    expect(p).toMatchObject({
      reelsAnalysed: 0,
      hookTimingSec: 0,
      cutPace: 0,
      captionStyles: [],
      confidence: 'low',
    })
    const reels = [facts({ hookTimingSec: null }), facts({ hookTimingSec: null })]
    expect(buildProfile(reels, equal(reels)).hookTimingSec).toBe(0)
  })
})

describe('confidence', () => {
  it('is low with fewer than three Reels, with nothing to rank by, or with a few numbers', () => {
    expect(confidenceOf(2, 2, true)).toBe('low')
    expect(confidenceOf(10, 0, false)).toBe('low')
    expect(confidenceOf(10, 10, false)).toBe('low')
    expect(confidenceOf(5, 2, true)).toBe('low')
  })
  it('is medium with five Reels and three with numbers, and high with ten and eight', () => {
    expect(confidenceOf(5, 3, true)).toBe('medium')
    expect(confidenceOf(9, 7, true)).toBe('medium')
    expect(confidenceOf(10, 8, true)).toBe('high')
    expect(confidenceOf(30, 30, true)).toBe('high')
  })
  it('follows from the Reels and the ranking when the profile is built', () => {
    const reels = Array.from({ length: 5 }, () => facts())
    expect(
      buildProfile(reels, selectWinners(reels.map((r, i) => ({ id: r.id, score: 50 + i }))))
        .confidence,
    ).toBe('medium')
    expect(
      buildProfile(reels, selectWinners(reels.map((r) => ({ id: r.id, score: null })))).confidence,
    ).toBe('low')
    const two = reels.slice(0, 2)
    expect(
      buildProfile(two, selectWinners(two.map((r, i) => ({ id: r.id, score: 50 + i })))).confidence,
    ).toBe('low')
  })
})
