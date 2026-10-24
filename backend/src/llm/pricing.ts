import type { TokenUsage } from './types.js'

/** US dollars per million tokens. Estimates for budgets and the usage table, not an invoice. */
interface Price {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}

/** A model we have no price for is costed like the most expensive one we know, so a budget errs on the safe side. */
const UNKNOWN: Price = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

export function estimateCostUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model] ?? UNKNOWN
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  )
}

const DEVANAGARI = /[ऀ-ॿ]/g

/**
 * A rough token count without calling anyone: Devanagari costs about a token a character, other text about
 * one per three. Used to refuse an enormous request before sending it, never for billing.
 */
export function estimateTokens(text: string): number {
  const dev = text.match(DEVANAGARI)?.length ?? 0
  return Math.ceil(dev + (text.length - dev) / 3)
}
