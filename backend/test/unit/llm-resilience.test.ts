import { describe, expect, it, vi } from 'vitest'
import { CircuitBreaker } from '../../src/llm/breaker.js'
import { estimateCostUsd, estimateTokens } from '../../src/llm/pricing.js'
import { withRetry } from '../../src/llm/retry.js'
import { LlmError } from '../../src/llm/types.js'

describe('retrying a model call', () => {
  const instant = async () => undefined

  it('returns the first success without waiting', async () => {
    const fn = vi.fn(async () => 'ok')
    expect(await withRetry(fn, { retries: 2, baseMs: 500, sleep: instant })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout, a rate limit and a server error, then succeeds', async () => {
    const errors = [
      new LlmError('timeout', 't'),
      new LlmError('rate_limited', 'r'),
      new LlmError('server', 's'),
    ]
    let i = 0
    const fn = vi.fn(async () => {
      if (i < errors.length) throw errors[i++]
      return 'ok'
    })
    expect(await withRetry(fn, { retries: 3, baseMs: 10, sleep: instant })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('stops after the allowed retries and throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw new LlmError('server', 'down')
    })
    await expect(withRetry(fn, { retries: 2, baseMs: 10, sleep: instant })).rejects.toMatchObject({
      kind: 'server',
    })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry what retrying cannot fix', async () => {
    for (const kind of [
      'unauthorized',
      'bad_request',
      'refused',
      'malformed',
      'too_large',
    ] as const) {
      const fn = vi.fn(async () => {
        throw new LlmError(kind, 'no')
      })
      await expect(withRetry(fn, { retries: 3, baseMs: 10, sleep: instant })).rejects.toMatchObject(
        { kind },
      )
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  it('does not retry an error that is not ours', async () => {
    const fn = vi.fn(async () => {
      throw new Error('bug')
    })
    await expect(withRetry(fn, { retries: 3, baseMs: 10, sleep: instant })).rejects.toThrow('bug')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('waits a random time up to base * 2^attempt (full jitter), growing each time', async () => {
    const waits: number[] = []
    const fn = vi.fn(async () => {
      throw new LlmError('server', 'x')
    })
    await withRetry(fn, {
      retries: 3,
      baseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => void waits.push(ms),
    }).catch(() => undefined)
    expect(waits).toEqual([50, 100, 200])
  })

  it('never waits less than the service asked for', async () => {
    const waits: number[] = []
    let first = true
    await withRetry(
      async () => {
        if (first) {
          first = false
          throw new LlmError('rate_limited', 'slow down', { retryAfterMs: 7000 })
        }
        return 'ok'
      },
      { retries: 1, baseMs: 10, random: () => 0.1, sleep: async (ms) => void waits.push(ms) },
    )
    expect(waits).toEqual([7000])
  })

  it('stops waiting when the caller gives up', async () => {
    const ctl = new AbortController()
    const fn = async () => {
      throw new LlmError('server', 'x')
    }
    const run = withRetry(fn, { retries: 3, baseMs: 60_000, random: () => 1 }, ctl.signal)
    setTimeout(() => ctl.abort(new Error('cancelled')), 20)
    await expect(run).rejects.toThrow('cancelled')
  })
})

describe('the circuit breaker', () => {
  function make(threshold = 3, cooldown = 1000) {
    let t = 0
    return {
      b: new CircuitBreaker(threshold, cooldown, () => t),
      advance: (ms: number) => (t += ms),
    }
  }

  it('lets calls through until enough fail in a row', () => {
    const { b } = make()
    b.failure()
    b.failure()
    expect(b.allow()).toBe(true)
    b.failure()
    expect(b.allow()).toBe(false)
    expect(b.open).toBe(true)
  })

  it('a success in between resets the count', () => {
    const { b } = make()
    b.failure()
    b.failure()
    b.success()
    b.failure()
    b.failure()
    expect(b.allow()).toBe(true)
  })

  it('after the cool-down lets exactly one trial call through', () => {
    const { b, advance } = make()
    for (let i = 0; i < 3; i++) b.failure()
    advance(999)
    expect(b.allow()).toBe(false)
    advance(2)
    expect(b.allow()).toBe(true)
    expect(b.allow()).toBe(false)
  })

  it('closes again when the trial succeeds, and reopens when it fails', () => {
    const a = make()
    for (let i = 0; i < 3; i++) a.b.failure()
    a.advance(1001)
    a.b.allow()
    a.b.success()
    expect(a.b.allow()).toBe(true)
    expect(a.b.open).toBe(false)

    const c = make()
    for (let i = 0; i < 3; i++) c.b.failure()
    c.advance(1001)
    c.b.allow()
    c.b.failure()
    expect(c.b.allow()).toBe(false)
    c.advance(1001)
    expect(c.b.allow()).toBe(true)
  })
})

describe('cost and size estimates', () => {
  it('prices a call from its tokens, cached reads far cheaper than fresh input', () => {
    const fresh = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    const cached = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    })
    const out = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(fresh).toBeCloseTo(2)
    expect(cached).toBeCloseTo(0.2)
    expect(out).toBeCloseTo(10)
  })

  it('the batch model is much cheaper than the planner model', () => {
    const u = { inputTokens: 10_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(estimateCostUsd('claude-haiku-5-5', u)).toBeLessThan(
      estimateCostUsd('claude-sonnet-5-5', u) / 10,
    )
  })

  it('costs a model it has no price for like the dearest one, so a budget errs safe', () => {
    const u = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(estimateCostUsd('some-new-model', u)).toBeGreaterThan(
      estimateCostUsd('claude-sonnet-5-5', u),
    )
  })

  it('counts Devanagari as dearer than Roman text of the same length', () => {
    expect(estimateTokens('नमस्ते दोस्तों आज फंडिंग की बात')).toBeGreaterThan(
      estimateTokens('namaste doston aaj funding'),
    )
    expect(estimateTokens('')).toBe(0)
  })
})
