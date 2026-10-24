import { LlmError } from './types.js'

export interface RetryOptions {
  /** Retries after the first try. */
  retries: number
  baseMs: number
  /** Replaced in tests so retries are instant. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  onRetry?: (e: LlmError, attempt: number, waitMs: number) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })

/**
 * Runs a call, retrying the failures worth retrying (timeout, rate limit, server error) with "full jitter": each
 * wait is a random time up to base * 2^attempt, so a crowd of callers does not retry in step. A rate limit's own
 * Retry-After is honoured when it asks for longer.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  signal?: AbortSignal,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep
  const random = opts.random ?? Math.random
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable || attempt >= opts.retries) throw e
      const jittered = random() * opts.baseMs * 2 ** attempt
      const wait = Math.max(jittered, e.retryAfterMs ?? 0)
      opts.onRetry?.(e, attempt + 1, wait)
      await sleep(wait, signal)
    }
  }
}
