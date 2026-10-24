import fs from 'node:fs'
import { TranscriptionError } from '../types.js'

/** Shared plumbing for the hosted providers: what counts as retryable, and abortable sleeping. */

export type FetchLike = typeof fetch

/**
 * Network trouble, rate limits and server errors are worth retrying. A rejected key or a request the
 * service calls invalid will fail the same way every time, so those are not.
 */
export function errorForStatus(service: string, status: number, body: string): TranscriptionError {
  const detail = body.slice(0, 300).replace(/\s+/g, ' ')
  const retryable = status === 408 || status === 429 || status >= 500
  const hint =
    status === 401 || status === 403
      ? ' Check the API key.'
      : status === 413
        ? ' The audio is too large.'
        : ''
  return new TranscriptionError(`${service} returned ${status}.${hint} ${detail}`.trim(), retryable)
}

export const networkError = (service: string, e: unknown) =>
  new TranscriptionError(`Could not reach ${service}: ${(e as Error).message}`, true)

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('cancelled'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('cancelled'))
      },
      { once: true },
    )
  })
}

/** A lazily-read Blob over a file, so a large upload is streamed rather than loaded into memory. */
export const fileBlob = (path: string, type: string): Promise<Blob> => fs.openAsBlob(path, { type })
