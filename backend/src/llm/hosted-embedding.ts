import { LlmError, type EmbeddingKind, type EmbeddingProvider } from './types.js'

export interface HostedEmbeddingOptions {
  /** Base URL of an OpenAI-compatible API, for example https://api.openai.com/v1 */
  url: string
  apiKey: string
  model: string
  dimensions: number
  similarityFloor: number
  timeoutMs: number
  fetch?: typeof fetch
}

const BATCH = 64

/**
 * Embeddings from any service that speaks the OpenAI `/embeddings` format (OpenAI, Voyage, a self-hosted server ...). The
 * vectors must be the size the database column expects; where the service allows it, that size is requested.
 */
export class HostedEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hosted'
  readonly model: string
  readonly dimensions: number
  readonly similarityFloor: number

  constructor(private readonly o: HostedEmbeddingOptions) {
    this.model = o.model
    this.dimensions = o.dimensions
    this.similarityFloor = o.similarityFloor
  }

  async embed(texts: string[], _kind: EmbeddingKind, signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await this.batch(texts.slice(i, i + BATCH), signal)))
    }
    return out
  }

  private async batch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const f = this.o.fetch ?? fetch
    let res: Response
    try {
      res = await f(`${this.o.url.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          input,
          dimensions: this.o.dimensions,
          encoding_format: 'float',
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs)])
          : AbortSignal.timeout(this.o.timeoutMs),
      })
    } catch (e) {
      const timedOut =
        e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new LlmError(
        timedOut ? 'timeout' : 'unavailable',
        'The embedding service could not be reached.',
      )
    }
    if (!res.ok) {
      const kind =
        res.status === 429
          ? 'rate_limited'
          : res.status >= 500
            ? 'server'
            : res.status === 401 || res.status === 403
              ? 'unauthorized'
              : 'bad_request'
      throw new LlmError(kind, `The embedding service answered ${res.status}.`)
    }
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ index: number; embedding: number[] }>
    } | null
    const rows = body?.data
    if (!Array.isArray(rows) || rows.length !== input.length)
      throw new LlmError('malformed', 'The embedding service sent an unexpected answer.')
    const vectors = [...rows].sort((a, b) => a.index - b.index).map((r) => r.embedding)
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.dimensions) {
        throw new LlmError(
          'malformed',
          `The embedding service sent vectors of the wrong size (want ${this.dimensions}).`,
        )
      }
    }
    return vectors.map((v) => {
      const norm = Math.hypot(...v) || 1
      return v.map((x) => x / norm)
    })
  }
}
