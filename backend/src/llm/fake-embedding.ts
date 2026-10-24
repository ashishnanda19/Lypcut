import { groupOf, tokenize } from '../modules/search/groups.js'
import { queryTerms } from '../modules/search/match.js'
import type { EmbeddingKind, EmbeddingProvider } from './types.js'

export const FAKE_DIMENSIONS = 384

/** FNV-1a: a small, stable hash. Not cryptographic, and does not need to be. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Hashed word vectors, offline. Each word is spelling-folded (so "phunding" and "funding", or a Roman and a Devanagari
 * spelling, land on the same feature) and its topic group adds a second feature (so "paisa" is near "funding"). The
 * features are hashed into a fixed-size vector with a sign, and the sentence's vector is the normalised sum. It
 * captures shared words and topics, not meaning in the way a trained model does, which is what a stand-in needs.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake'
  readonly model = 'hashed-words'
  readonly dimensions = FAKE_DIMENSIONS

  async embed(texts: string[], _kind: EmbeddingKind): Promise<number[][]> {
    return texts.map((t) => this.one(t))
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0)
    const add = (feature: string, weight: number) => {
      const h = hash(feature)
      v[h % this.dimensions]! += (h & 0x80000000 ? -1 : 1) * weight
    }
    for (const term of queryTerms(text)) {
      add(`w:${term.key}`, 1)
      if (term.group !== undefined) add(`g:${term.group}`, 0.8)
    }
    // Words the query matcher skips as filler still carry a little signal for short texts.
    for (const raw of tokenize(text)) {
      const g = groupOf(raw)
      if (g !== undefined) add(`g:${g}`, 0.2)
    }
    const norm = Math.hypot(...v)
    return norm ? v.map((x) => x / norm) : v
  }
}
