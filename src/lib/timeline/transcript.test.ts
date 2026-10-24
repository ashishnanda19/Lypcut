import { describe, expect, it } from 'vitest'
import { generateSource } from '@/mocks/data/seed'
import { applyOp } from './ops'
import { fixture } from './fixtures'
import { cutFlags, captionItems, timelineDuration, trackItems } from './queries'
import {
  buildCaptionPhrases,
  captionsForTimeline,
  cutWords,
  fillerIndices,
  keepRangeOp,
  removeFillersOp,
  restoreWords,
  trimPausesOp,
} from './transcript'

describe('seed transcript', () => {
  it('is deterministic and well formed', () => {
    const a = generateSource('p_funding', 0, 56)
    const b = generateSource('p_funding', 0, 56)
    expect(a.transcript.words.length).toBe(b.transcript.words.length)
    expect(a.duration).toBe(b.duration)
    expect(a.transcript.words.length).toBeGreaterThan(450)
    const ws = a.transcript.words
    for (let i = 1; i < ws.length; i++)
      expect(ws[i]!.start).toBeGreaterThanOrEqual(ws[i - 1]!.end - 1e-6)
    expect(ws.every((w) => w.dev.length > 0 && w.text.length > 0)).toBe(true)
    expect(ws.filter((w) => w.filler).length).toBeGreaterThanOrEqual(10)
    expect(ws.some((w) => w.language === 'en') && ws.some((w) => w.language === 'hi')).toBe(true)
    expect(a.highlights.length).toBeGreaterThanOrEqual(6)
    expect(a.chapters.length).toBe(7)
    expect(a.scenes[0]!.start).toBe(0)
    expect(a.scenes[a.scenes.length - 1]!.end).toBe(a.duration)
    // scenes are contiguous
    a.scenes.forEach((s, i) => i && expect(s.start).toBe(a.scenes[i - 1]!.end))
  })

  it('supports long projects (an hour of footage) without trouble', () => {
    const long = generateSource('long', 3, 800)
    expect(long.duration).toBeGreaterThan(3000)
    expect(long.transcript.words.length).toBeGreaterThan(6000)
  })
})

describe('editing by transcript', () => {
  const { timeline: tl, words } = fixture()

  it('deleting words cuts them from the edit and flags them as cut', () => {
    const i0 = 20
    const i1 = 27
    const r = applyOp(tl, cutWords(words, i0, i1))
    const flags = cutFlags(r.timeline, words)
    for (let i = i0; i <= i1; i++) expect(flags[i]).toBe(1)
    expect(flags[i1 + 2]).toBe(0)
    expect(timelineDuration(r.timeline)).toBeLessThan(timelineDuration(tl))
  })

  it('restoring words brings them back', () => {
    const cut = applyOp(tl, cutWords(words, 20, 27))
    const back = applyOp(cut.timeline, restoreWords(cut.timeline, words, 20, 27))
    const flags = cutFlags(back.timeline, words)
    for (let i = 20; i <= 27; i++) expect(flags[i]).toBe(0)
    expect(timelineDuration(back.timeline)).toBeCloseTo(timelineDuration(tl), 1)
  })

  it('removes every filler in one op and says how many', () => {
    const planned = removeFillersOp(tl, words)!
    expect(planned.count).toBe(fillerIndices(tl, words).length)
    const r = applyOp(tl, planned.op)
    expect(fillerIndices(r.timeline, words)).toHaveLength(0)
    expect(removeFillersOp(r.timeline, words)).toBeNull()
    expect(timelineDuration(tl) - timelineDuration(r.timeline)).toBeCloseTo(planned.seconds, 0)
    // and it all undoes as one step
    const undone = applyOp(r.timeline, r.inverse)
    expect(fillerIndices(undone.timeline, words)).toHaveLength(planned.count)
  })

  it('trims long pauses but keeps a natural beat', () => {
    const planned = trimPausesOp(tl, words)
    expect(planned).not.toBeNull()
    const r = applyOp(tl, planned!.op)
    expect(timelineDuration(r.timeline)).toBeLessThan(timelineDuration(tl))
    expect(trimPausesOp(r.timeline, words)).toBeNull()
  })

  it('keeps only a highlight range', () => {
    const hl = fixture().src.highlights[0]!
    const r = applyOp(tl, keepRangeOp(hl.start, hl.end, tl.sourceDuration))
    expect(timelineDuration(r.timeline)).toBeCloseTo(hl.end - hl.start, 0)
  })

  it('builds captions that stay in sync after cuts', () => {
    const phrases = buildCaptionPhrases(words)
    expect(phrases.length).toBeGreaterThan(80)
    expect(phrases.every((p) => (p.meta?.text ?? '').split(' ').length <= 4)).toBe(true)

    const cut = applyOp(tl, cutWords(words, 20, 27)).timeline
    const caps = captionsForTimeline(cut, words)
    const withCaps = applyOp(cut, { type: 'addCaptions', items: caps, replace: true }).timeline
    expect(captionItems(withCaps).length).toBe(caps.length)
    expect(withCaps.settings.captionsOn).toBe(true)
    const sorted = trackItems(withCaps, 'trk_captions')
    sorted.forEach(
      (c, i) =>
        i &&
        expect(c.start).toBeGreaterThanOrEqual(
          sorted[i - 1]!.start + sorted[i - 1]!.duration - 1e-6,
        ),
    )
  })
})
