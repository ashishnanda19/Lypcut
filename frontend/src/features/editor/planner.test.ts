import { describe, expect, it } from 'vitest'
import { fixture } from '@/lib/timeline/fixtures'
import { applyOp } from '@lypcut/timeline-core'
import { timelineDuration } from '@lypcut/timeline-core'
import { answerQuestion, plan, type PlannerContext } from './planner'

const { src, timeline } = fixture()
const ctx = (over: Partial<PlannerContext> = {}): PlannerContext => ({
  tl: timeline,
  tr: src.transcript,
  highlights: src.highlights,
  chapters: src.chapters,
  lang: 'hinglish',
  applyStyle: false,
  playhead: 0,
  ...over,
})

describe('planner', () => {
  it('understands the same request in English, Hinglish and Hindi', () => {
    for (const q of ['remove filler words', 'filler hata do', 'फिलर हटा दो']) {
      const r = plan(q, ctx())
      expect(r.plan?.title, q).toBeTruthy()
      expect(applyOp(timeline, r.plan!.op).timeline).toBeTruthy()
    }
  })

  it('replies in Devanagari when asked in Devanagari', () => {
    const r = plan('फिलर हटा दो', ctx())
    expect(r.text).toMatch(/[ऀ-ॿ]/)
  })

  it('produces ops that actually shorten the edit', () => {
    const r = plan('remove fillers', ctx())
    expect(timelineDuration(applyOp(timeline, r.plan!.op).timeline)).toBeLessThan(
      timelineDuration(timeline),
    )
  })

  it('says so when there is nothing left to remove', () => {
    const first = plan('remove fillers', ctx())
    const after = applyOp(timeline, first.plan!.op).timeline
    const again = plan('remove fillers', ctx({ tl: after }))
    expect(again.plan).toBeUndefined()
    expect(again.text).toMatch(/tight|bacha/)
  })

  it('adds captions as a validated op with a strip and summary', () => {
    const r = plan('add captions', ctx())
    expect(r.plan?.summary.some((s) => s.label === 'Captions')).toBe(true)
    const next = applyOp(timeline, r.plan!.op).timeline
    expect(Object.values(next.items).filter((i) => i.kind === 'caption').length).toBeGreaterThan(5)
    expect(next.settings.captionsOn).toBe(true)
  })

  it('switches caption style by name', () => {
    const r = plan('switch to karaoke captions', ctx())
    expect(applyOp(timeline, r.plan!.op).timeline.settings.captionStyleId).toBe('karaoke')
  })

  it('asks structured questions before making a Reel, then builds it', () => {
    const r1 = plan('make a reel', ctx())
    expect(r1.question?.options.map((o) => o.id)).toEqual(['best', 'here', 'all'])
    const r2 = answerQuestion(r1.question!, 'best', ctx())
    expect(r2.question?.options.map((o) => o.id)).toEqual(['15', '30', '60'])
    const r3 = answerQuestion(r2.question!, '30', ctx())
    expect(r3.question?.options.map((o) => o.id)).toEqual(['fast', 'calm'])
    const r4 = answerQuestion(r3.question!, 'fast', ctx())
    expect(r4.plan).toBeTruthy()
    const out = applyOp(timeline, r4.plan!.op).timeline
    const dur = timelineDuration(out)
    expect(dur).toBeGreaterThan(10)
    expect(dur).toBeLessThan(45)
  })

  it('skips questions it can already answer', () => {
    const r = plan('make a 30 second reel from my best hook, fast', ctx())
    expect(r.question).toBeUndefined()
    expect(r.plan).toBeTruthy()
  })

  it('finds a moment from a spoken-style search', () => {
    const r = plan('where I talk about funding', ctx())
    expect(r.open?.tab).toBe('search')
    expect(r.open?.query).toMatch(/funding/)
  })

  it('puts a blur on the effects track at the playhead', () => {
    const r = plan('blur the background', ctx({ playhead: 12 }))
    const out = applyOp(timeline, r.plan!.op).timeline
    const fx = Object.values(out.items).find((i) => i.kind === 'effect')
    expect(fx?.start).toBe(12)
    expect(fx?.meta?.effect).toBe('blur')
  })

  it('points to the Style page when no style is connected', () => {
    const r = plan('apply my style', ctx())
    expect(r.route).toBe('/app/style')
  })

  it('falls back to helpful suggestions', () => {
    const r = plan('asdf qwer', ctx())
    expect(r.chips?.length).toBeGreaterThan(2)
  })
})
