import { describe, expect, it } from 'vitest'
import type { DerivedProfile } from '../../src/style/analysis/profile.js'
import {
  acceptSummary,
  factsKey,
  summaryFacts,
  templateSummary,
} from '../../src/style/analysis/summary.js'
import { fakeStyle } from '../../src/style/analysis/fake.js'
import { dataBlock } from '../../src/llm/data-block.js'
import { enqueueJob } from '../../src/queue/enqueue.js'
import type { Queues } from '../../src/queue/queues.js'

const profile = (over: Partial<DerivedProfile> = {}): DerivedProfile => ({
  reelsAnalysed: 8,
  hookTimingSec: 1.6,
  cutPace: 4.8,
  captionStyles: [{ id: 'saffron-pop', share: 1 }],
  music: [],
  hookRetention: [],
  fonts: ['Inter'],
  colors: [],
  confidence: 'medium',
  ...over,
})

describe('the figures a summary may use', () => {
  it('are the timing, how often it cuts, the top look and how sure, and nothing else', () => {
    const f = summaryFacts(profile(), 'en')
    expect(f).toEqual({
      language: 'en',
      hookTimingSec: 1.6,
      cutEverySec: 2.1,
      cutPace: 4.8,
      topCaptionStyle: 'Saffron Pop',
      reels: 8,
      confidence: 'medium',
    })
  })
  it('skips a custom look, and says nothing about cuts when there are almost none', () => {
    const f = summaryFacts(
      profile({
        cutPace: 0.2,
        captionStyles: [
          { id: 'custom', share: 0.7 },
          { id: 'boxed', share: 0.3 },
        ],
      }),
      'en',
    )
    expect(f.cutEverySec).toBeNull()
    expect(f.topCaptionStyle).toBe('Boxed')
    expect(
      summaryFacts(profile({ captionStyles: [{ id: 'custom', share: 1 }] }), 'en').topCaptionStyle,
    ).toBeNull()
  })
  it('have a key that changes only when a figure does', () => {
    const a = factsKey(summaryFacts(profile(), 'en'))
    expect(factsKey(summaryFacts(profile(), 'en'))).toBe(a)
    expect(factsKey(summaryFacts(profile({ hookTimingSec: 2.4 }), 'en'))).not.toBe(a)
    expect(factsKey(summaryFacts(profile(), 'hi'))).not.toBe(a)
  })
})

describe('the sentence', () => {
  it('reads the way the product describes it, in each language', () => {
    expect(templateSummary(summaryFacts(profile({ confidence: 'high' }), 'en'))).toBe(
      'Your best Reels hook in under 2 seconds and cut every 2.1 seconds, with Saffron Pop captions.',
    )
    expect(templateSummary(summaryFacts(profile({ confidence: 'high' }), 'hinglish'))).toMatch(
      /^Aapki best Reels 2 second ke andar hook karti hain aur har 2\.1 second mein cut aata hai/,
    )
    expect(templateSummary(summaryFacts(profile({ confidence: 'high' }), 'hi'))).toMatch(
      /2 सेकंड के अंदर/,
    )
  })
  it('says when it comes from only a few Reels, and when the Reels barely cut or start at once', () => {
    expect(templateSummary(summaryFacts(profile({ confidence: 'low' }), 'en'))).toContain(
      '(from only a few Reels)',
    )
    expect(templateSummary(summaryFacts(profile({ cutPace: 0 }), 'en'))).toContain('rarely cut')
    expect(templateSummary(summaryFacts(profile({ hookTimingSec: 0.4 }), 'en'))).toContain(
      'under 1 second',
    )
  })
  it('is always accepted by its own guard', () => {
    for (const lang of ['en', 'hinglish', 'hi'] as const)
      for (const p of [
        profile(),
        profile({ confidence: 'low' }),
        profile({ cutPace: 0, hookTimingSec: 0 }),
      ]) {
        const f = summaryFacts(p, lang)
        expect(acceptSummary(templateSummary(f), f)).not.toBeNull()
      }
  })
})

describe('accepting a sentence from a model', () => {
  const f = summaryFacts(profile(), 'en')
  it('accepts one that uses the figures, as given or rounded', () => {
    for (const s of [
      'Your best Reels hook in under 2 seconds and cut every 2.1 seconds.',
      'Your best Reels start within 1.6 seconds and cut about every 2 seconds.',
      'From 8 Reels: they hook in 2 seconds and cut roughly every 2.1 seconds.',
    ])
      expect(acceptSummary(s, f), s).toBe(s)
  })
  it('refuses a figure it was not given, a number written as a word, more than one line, or the wrong length', () => {
    for (const s of [
      'Your best Reels hook in under 3 seconds and cut every 2.1 seconds.',
      'Your best Reels cut every 7.5 seconds.',
      'Your best Reels hook in under two seconds.',
      'Your best Reels hook in under 2 seconds.\nThey cut every 2.1 seconds.',
      'Hi',
      'x'.repeat(250),
      'Your best Reels get 95 percent retention and hook in 2 seconds.',
    ])
      expect(acceptSummary(s, f), s).toBeNull()
  })
})

describe('the offline model for style work', () => {
  const ask = (tool: string, context: string) =>
    fakeStyle({
      purpose: 'style',
      system: '',
      context,
      messages: [],
      tools: [{ name: tool, description: '', schema: {} as never }],
      maxOutputTokens: 100,
    })

  it('labels every Reel custom: it cannot see pictures, so it does not guess', () => {
    const out = ask('label_captions', dataBlock({ videos: [{ id: 'a' }, { id: 'b' }] }))
    expect(out.toolCall?.input).toEqual({
      items: [
        { id: 'a', style: 'custom', font: 'unknown' },
        { id: 'b', style: 'custom', font: 'unknown' },
      ],
    })
  })
  it('writes the template sentence for the figures', () => {
    const facts = summaryFacts(profile(), 'en')
    const out = ask('write_summary', dataBlock(facts))
    expect((out.toolCall?.input as { sentence: string }).sentence).toBe(templateSummary(facts))
  })
})

describe('style jobs go to their own queue', () => {
  const queues = () => {
    const added: string[] = []
    const q = (name: string) => ({ add: async () => void added.push(name) })
    return {
      added,
      queues: {
        processing: q('processing'),
        maintenance: q('maintenance'),
        style: q('style'),
      } as unknown as Queues,
    }
  }
  it('so style work cannot take editing work’s workers', async () => {
    const { added, queues: qs } = queues()
    for (const type of ['style_analysis', 'style_sync', 'style_refresh', 'style_deletion'] as const)
      await enqueueJob(qs, { id: 'j', type })
    await enqueueJob(qs, { id: 'j', type: 'processing' })
    await enqueueJob(qs, { id: 'j', type: 'delete_account' })
    expect(added).toEqual(['style', 'style', 'style', 'style', 'processing', 'maintenance'])
  })
})
