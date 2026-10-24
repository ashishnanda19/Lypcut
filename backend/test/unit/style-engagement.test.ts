import { describe, expect, it } from 'vitest'
import { ENGAGEMENT } from '../../src/style/analysis/config.js'
import {
  engagementScores,
  signalsOf,
  skipReason,
  watchPct,
  type ReelNumbers,
} from '../../src/style/analysis/engagement.js'
import { selectWinners } from '../../src/style/analysis/winners.js'

const NOW = new Date('2026-10-25T00:00:00Z')
const old = new Date('2026-09-01T00:00:00Z')
const scores = (items: Array<[string, ReelNumbers | null]>) =>
  engagementScores(
    items.map(([id, numbers]) => ({ id, numbers })),
    NOW,
  )
const score = (m: ReturnType<typeof scores>, id: string) => m.get(id)!.score

/** Numbers for a Reel seen by `views` people, with rates as given. */
const reel = (
  views: number,
  r: { saves?: number; shares?: number; comments?: number; likes?: number; watch?: number },
): ReelNumbers => ({
  views,
  saves: r.saves === undefined ? undefined : Math.round(views * r.saves),
  shares: r.shares === undefined ? undefined : Math.round(views * r.shares),
  comments: r.comments === undefined ? undefined : Math.round(views * r.comments),
  likes: r.likes === undefined ? undefined : Math.round(views * r.likes),
  avgWatchPct: r.watch,
  postedAt: old,
})

describe('engagement signals', () => {
  it('are rates per view, so a bigger audience alone changes nothing', () => {
    const small = signalsOf({ views: 1_000, saves: 50, shares: 20 })
    const big = signalsOf({ views: 1_000_000, saves: 50_000, shares: 20_000 })
    expect(small.saves).toBeCloseTo(big.saves!)
    expect(small.shares).toBeCloseTo(big.shares!)
  })

  it('leave out what is missing, and use reach when views are missing', () => {
    expect(signalsOf({ views: 1000, saves: 10 })).toEqual({ saves: 0.01 })
    expect(signalsOf({ reach: 500, likes: 50 })).toEqual({ likes: 0.1 })
    expect(signalsOf({ likes: 50 })).toEqual({})
    // A real zero is a signal; not knowing is not.
    expect(signalsOf({ views: 1000, saves: 0 })).toEqual({ saves: 0 })
  })

  it('turns Instagram’s watch seconds into a share of the Reel, and refuses to invent one', () => {
    expect(watchPct(12, 30)).toBe(40)
    expect(watchPct(45, 30)).toBe(100)
    expect(watchPct(null, 30)).toBeNull()
    expect(watchPct(12, null)).toBeNull()
    expect(watchPct(12, 0)).toBeNull()
  })

  it('weights saves, shares and watch time above likes', () => {
    const w = ENGAGEMENT.weights
    expect(w.likes).toBeLessThan(w.comments)
    expect(w.comments).toBeLessThan(w.saves)
    expect(Math.min(w.watch, w.saves, w.shares)).toBeGreaterThan(w.likes * 4)
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
})

describe('who can be scored', () => {
  it('not a Reel seen by too few people, a Reel posted too recently, or one with a single number', () => {
    expect(skipReason({ views: 50, saves: 5, shares: 5 }, NOW)).toBe('too_few_views')
    expect(
      skipReason(
        { views: 5_000, saves: 5, shares: 5, postedAt: new Date('2026-10-24T00:00:00Z') },
        NOW,
      ),
    ).toBe('too_new')
    expect(skipReason({ views: 5_000, saves: 5 }, NOW)).toBe('too_few_signals')
    expect(skipReason({ views: 5_000, saves: 5, shares: 5, postedAt: old }, NOW)).toBeNull()
  })

  it('an upload has no age, so it is never too new; rates need views or reach, so numbers without them are one signal', () => {
    expect(skipReason({ views: 800, saves: 5, shares: 5, avgWatchPct: 50 }, NOW)).toBeNull()
    expect(skipReason({ saves: 5, shares: 5, avgWatchPct: 50 }, NOW)).toBe('too_few_signals')
    expect(skipReason({ reach: 800, saves: 5, shares: 5 }, NOW)).toBeNull()
  })
})

describe('the score', () => {
  it('ranks a creator’s Reels against each other, 0 to 100, best highest', () => {
    const m = scores([
      ['a', reel(10_000, { saves: 0.01, shares: 0.01, comments: 0.002, likes: 0.05, watch: 30 })],
      ['b', reel(10_000, { saves: 0.03, shares: 0.02, comments: 0.004, likes: 0.08, watch: 50 })],
      ['c', reel(10_000, { saves: 0.06, shares: 0.04, comments: 0.006, likes: 0.1, watch: 70 })],
    ])
    expect(score(m, 'c')).toBe(100)
    expect(score(m, 'a')).toBe(0)
    expect(score(m, 'b')).toBe(50)
  })

  it('is relative to the creator: a small account’s best Reel scores as high as a big account’s', () => {
    const shape = (views: number) => [
      reel(views, { saves: 0.01, shares: 0.01, watch: 30 }),
      reel(views, { saves: 0.02, shares: 0.02, watch: 50 }),
      reel(views, { saves: 0.04, shares: 0.03, watch: 70 }),
    ]
    const small = scores(shape(500).map((n, i) => [`r${i}`, n]))
    const big = scores(shape(5_000_000).map((n, i) => [`r${i}`, n]))
    for (const id of ['r0', 'r1', 'r2']) expect(score(small, id)).toBe(score(big, id))
  })

  it('uses rates, not counts: more saves from far more views is not better', () => {
    const m = scores([
      ['rate', reel(2_000, { saves: 0.08, shares: 0.05 })],
      ['count', reel(2_000_000, { saves: 0.002, shares: 0.001 })],
      ['mid', reel(20_000, { saves: 0.03, shares: 0.02 })],
    ])
    expect(score(m, 'rate')!).toBeGreaterThan(score(m, 'count')!)
  })

  it('a Reel with no watch time is not marked down for it', () => {
    const m = scores([
      ['with', reel(5_000, { saves: 0.02, shares: 0.02, watch: 40 })],
      ['without', reel(5_000, { saves: 0.02, shares: 0.02 })],
      ['worse', reel(5_000, { saves: 0.005, shares: 0.005, watch: 20 })],
    ])
    expect(score(m, 'without')).toBeGreaterThan(score(m, 'worse')!)
  })

  it('gives a Reel with no numbers null and says why, without disturbing the others', () => {
    const m = scores([
      ['a', reel(5_000, { saves: 0.01, shares: 0.01 })],
      ['b', reel(5_000, { saves: 0.03, shares: 0.02 })],
      ['none', null],
      ['tiny', { views: 20, saves: 2, shares: 2 }],
    ])
    expect(m.get('none')).toEqual({ score: null, skipped: 'no_numbers' })
    expect(m.get('tiny')).toEqual({ score: null, skipped: 'too_few_views' })
    expect(score(m, 'b')).toBe(100)
    expect(score(m, 'a')).toBe(0)
  })

  it('ties share a rank, a lone Reel is 50, and everything is deterministic', () => {
    const same = scores([
      ['a', reel(1_000, { saves: 0.02, shares: 0.02 })],
      ['b', reel(1_000, { saves: 0.02, shares: 0.02 })],
    ])
    expect(score(same, 'a')).toBe(50)
    expect(score(same, 'b')).toBe(50)
    expect(score(scores([['solo', reel(1_000, { saves: 0.02, shares: 0.02 })]]), 'solo')).toBe(50)
    const items: Array<[string, ReelNumbers]> = [
      ['a', reel(1_000, { saves: 0.01, shares: 0.03 })],
      ['b', reel(2_000, { saves: 0.03, shares: 0.01 })],
      ['c', reel(3_000, { saves: 0.02, shares: 0.02 })],
    ]
    expect([...scores(items)]).toEqual(
      [...scores([...items].reverse())].sort((x, y) => x[0].localeCompare(y[0])),
    )
  })
})

describe('winners', () => {
  const ids = (n: number, scoreOf: (i: number) => number | null) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${String(i).padStart(2, '0')}`,
      score: scoreOf(i),
    }))

  it('are the best third, at least three', () => {
    const s = selectWinners(ids(30, (i) => i))
    expect(s.ranked).toBe(true)
    expect(s.winners).toHaveLength(10)
    expect(s.winners.map((w) => w.id)).toContain('r29')
    expect(s.winners.map((w) => w.id)).not.toContain('r19')
    expect(selectWinners(ids(9, (i) => i)).winners).toHaveLength(3)
    expect(selectWinners(ids(10, (i) => i)).winners).toHaveLength(4)
    expect(selectWinners(ids(5, (i) => i)).winners).toHaveLength(3)
    expect(selectWinners(ids(3, (i) => i)).winners).toHaveLength(3)
  })

  it('weights by score, and the weights add up to 1', () => {
    const s = selectWinners(ids(6, (i) => (i + 1) * 10))
    expect(s.winners.reduce((n, w) => n + w.weight, 0)).toBeCloseTo(1)
    const [first, second] = s.winners.sort((a, b) => b.weight - a.weight)
    expect(first!.weight).toBeGreaterThan(second!.weight)
  })

  it('with fewer than three Reels, uses them all equally and is not ranked', () => {
    for (const n of [1, 2]) {
      const s = selectWinners(ids(n, (i) => 50 + i))
      expect(s.ranked).toBe(false)
      expect(s.winners).toHaveLength(n)
      for (const w of s.winners) expect(w.weight).toBeCloseTo(1 / n)
    }
    expect(selectWinners([])).toEqual({ winners: [], ranked: false })
  })

  it('with no numbers at all, every Reel is an equal winner', () => {
    const s = selectWinners(ids(5, () => null))
    expect(s.ranked).toBe(false)
    expect(s.winners).toHaveLength(5)
    for (const w of s.winners) expect(w.weight).toBeCloseTo(0.2)
  })

  it('with fewer than three scored Reels among others, there is nothing to rank by, so all count equally', () => {
    const s = selectWinners(ids(6, (i) => (i < 2 ? 80 : null)))
    expect(s.ranked).toBe(false)
    expect(s.winners).toHaveLength(6)
  })

  it('never lets an unscored Reel win when others are scored, and breaks ties the same way every time', () => {
    const items = ids(8, (i) => (i < 5 ? 60 : null))
    const s = selectWinners(items)
    expect(s.winners.map((w) => w.id).sort()).toEqual(['r00', 'r01', 'r02'])
    expect(
      selectWinners([...items].reverse())
        .winners.map((w) => w.id)
        .sort(),
    ).toEqual(['r00', 'r01', 'r02'])
  })

  it('gives a score of 0 a small weight rather than none', () => {
    const s = selectWinners([
      { id: 'a', score: 0 },
      { id: 'b', score: 0 },
      { id: 'c', score: 0 },
    ])
    expect(s.winners.every((w) => w.weight > 0)).toBe(true)
  })
})
