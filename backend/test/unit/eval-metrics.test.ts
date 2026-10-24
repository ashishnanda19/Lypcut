import { describe, expect, it } from 'vitest'
import { GOLDEN } from '../../eval/golden.js'
import { mean, percentile, summarize, type CaseRun } from '../../eval/metrics.js'

const run = (over: Partial<CaseRun> = {}): CaseRun => ({
  id: 'x',
  prompt: 'x',
  tool: 'remove_fillers',
  finalTool: 'remove_fillers',
  outcome: 'plan',
  calls: 1,
  latencyMs: 100,
  inputTokens: 1000,
  outputTokens: 50,
  costUsd: 0.002,
  planValid: true,
  toolOk: true,
  outcomeOk: true,
  notes: [],
  ...over,
})

describe('percentile', () => {
  it('is the nearest rank', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(v, 0.5)).toBe(50)
    expect(percentile(v, 0.95)).toBe(100)
    expect(percentile(v, 0)).toBe(10)
  })
  it('does not care about order, and is 0 for nothing', () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2)
    expect(percentile([], 0.95)).toBe(0)
  })
  it('mean of nothing is 0', () => expect(mean([])).toBe(0))
})

describe('summarize', () => {
  it('reports accuracy, validity, repair rate, latency, tokens and cost', () => {
    const s = summarize([
      run(),
      run({
        toolOk: false,
        outcomeOk: false,
        outcome: 'text',
        planValid: undefined,
        calls: 2,
        latencyMs: 900,
      }),
      run({ outcome: 'plan', planValid: false }),
      run({
        outcome: 'text',
        calls: 0,
        planValid: undefined,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }),
    ])
    expect(s.cases).toBe(4)
    expect(s.toolAccuracy).toBe(0.75)
    expect(s.plans).toBe(2)
    expect(s.validity).toBe(0.5)
    // Of the three that reached the model, one was asked to correct itself.
    expect(s.repairRate).toBeCloseTo(1 / 3)
    expect(s.modelCalls).toBe(4)
    expect(s.latencyP95Ms).toBe(900)
    expect(s.inputTokensPerRequest).toBe(750)
    expect(s.costPer1000Usd).toBeCloseTo(1.5)
  })
  it('has nothing to report without runs', () => {
    expect(summarize([])).toMatchObject({ cases: 0, plans: 0, validity: 1, repairRate: 0 })
  })
})

describe('the golden set', () => {
  it('has at least forty prompts with unique ids, in all three ways of writing', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(40)
    expect(new Set(GOLDEN.map((c) => c.id)).size).toBe(GOLDEN.length)
    expect(GOLDEN.filter((c) => /[ऀ-ॿ]/.test(c.text)).length).toBeGreaterThanOrEqual(5)
    expect(GOLDEN.filter((c) => /^(hi|dev)-/.test(c.id)).length).toBeGreaterThanOrEqual(15)
  })
  it('covers every tool the assistant has', () => {
    const wanted = new Set(GOLDEN.flatMap((c) => (Array.isArray(c.tool) ? c.tool : [c.tool])))
    for (const tool of [
      'remove_fillers',
      'trim_pauses',
      'add_captions',
      'set_caption_style',
      'make_reel',
      'find_moment',
      'best_hooks',
      'cut_range',
      'trim_intro',
      'add_effect',
      'ask_question',
      'undo',
      'redo',
      'none',
    ])
      expect(wanted.has(tool), tool).toBe(true)
  })
})
