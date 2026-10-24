import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HostedEmbeddingProvider } from '../../src/llm/hosted-embedding.js'
import { createEmbeddings } from '../../src/llm/index.js'
import { FakeEmbeddingProvider } from '../../src/llm/fake-embedding.js'
import { hasModel, TransformersEmbeddingProvider } from '../../src/llm/transformers-embedding.js'
import { LlmError } from '../../src/llm/types.js'
import { closeWindows, fuse, RRF_K, type LexicalHit } from '../../src/modules/search/fusion.js'
import type { SentenceRow } from '../../src/modules/search/match.js'
import {
  embeddingsKey,
  QueryVectorCache,
  vectorLiteral,
  WINDOW,
  windowsFor,
  type SemanticWindow,
} from '../../src/modules/search/semantic.js'

const row = (idx: number): SentenceRow => ({
  idx,
  from: idx * 5,
  to: idx * 5 + 5,
  start: idx * 6,
  end: idx * 6 + 5,
})
const win = (first: number, last: number, similarity: number): SemanticWindow => ({
  first,
  last,
  start: first * 6,
  end: last * 6 + 5,
  similarity,
})
const lex = (idx: number, score: number): LexicalHit => ({
  sentence: row(idx),
  score,
  matched: [idx * 5],
})

describe('sentence windows', () => {
  const sentences = Array.from({ length: 6 }, (_, i) => ({
    idx: i,
    start: i * 6,
    end: i * 6 + 5,
    text: `Sentence ${i}.`,
  }))
  const windows = windowsFor(sentences)

  it('makes one window per sentence, each starting on that sentence', () => {
    expect(windows).toHaveLength(6)
    expect(windows.map((w) => w.first)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('covers the sentence and the next two, fewer at the end', () => {
    expect(WINDOW).toBe(3)
    expect(windows[0]).toMatchObject({
      first: 0,
      last: 2,
      start: 0,
      end: 17,
      text: 'Sentence 0. Sentence 1. Sentence 2.',
    })
    expect(windows[4]).toMatchObject({ first: 4, last: 5, end: 35 })
    expect(windows[5]).toMatchObject({ first: 5, last: 5, text: 'Sentence 5.' })
  })

  it('starts and ends every window on a sentence boundary', () => {
    for (const w of windows) {
      expect(sentences[w.first]!.start).toBe(w.start)
      expect(sentences[w.last]!.end).toBe(w.end)
    }
  })

  it('cuts a very long window short rather than sending more than the model can read', () => {
    const long = windowsFor([{ idx: 0, start: 0, end: 50, text: 'word '.repeat(2000) }])
    expect(long[0]!.text.length).toBeLessThanOrEqual(1400)
  })

  it('has no windows for no sentences', () => {
    expect(windowsFor([])).toEqual([])
  })

  it('keys stored vectors by the transcript, the model and how they were cut', () => {
    const k = embeddingsKey('abc', 'm1', 384)
    expect(k).not.toBe(embeddingsKey('abd', 'm1', 384))
    expect(k).not.toBe(embeddingsKey('abc', 'm2', 384))
    expect(k).not.toBe(embeddingsKey('abc', 'm1', 768))
  })

  it('writes a vector the way pgvector reads it, and turns anything but a number into 0', () => {
    expect(vectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]')
    expect(vectorLiteral([Number.NaN, Infinity, 2])).toBe('[0,0,2]')
  })
})

describe('the query vector cache', () => {
  it('returns what was stored until it expires', () => {
    let now = 0
    const c = new QueryVectorCache(1000, 10, () => now)
    c.set('a', [1])
    expect(c.get('a')).toEqual([1])
    now = 999
    expect(c.get('a')).toEqual([1])
    now = 1001
    expect(c.get('a')).toBeUndefined()
  })

  it('forgets the oldest when it is full', () => {
    const c = new QueryVectorCache(10_000, 2)
    c.set('a', [1])
    c.set('b', [2])
    c.set('c', [3])
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toEqual([2])
    expect(c.get('c')).toEqual([3])
  })

  it('remembers nothing when the time-to-live is zero', () => {
    const c = new QueryVectorCache(0)
    c.set('a', [1])
    expect(c.get('a')).toBeUndefined()
  })
})

describe('which windows count as close in meaning', () => {
  it('drops everything below the floor', () => {
    expect(closeWindows([win(0, 2, 0.7), win(3, 5, 0.6)], 0.8)).toEqual([])
  })

  it('keeps windows close to the best one, relative to the room above the floor', () => {
    // floor 0.8: margin is 40% of 0.2 = 0.08 below the best.
    const kept = closeWindows([win(0, 2, 0.9), win(3, 5, 0.85), win(6, 8, 0.81)], 0.8)
    expect(kept.map((w) => w.first)).toEqual([0, 3])
  })

  it('works for a model that spreads scores widely', () => {
    const kept = closeWindows(
      [win(0, 2, 0.9), win(3, 5, 0.7), win(6, 8, 0.5), win(9, 11, 0.2)],
      0.3,
    )
    expect(kept.map((w) => w.first)).toEqual([0, 3])
  })

  it('returns nothing for nothing, and never more than the maximum', () => {
    expect(closeWindows([], 0.5)).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => win(i, i + 2, 0.99))
    expect(closeWindows(many, 0.5, 12)).toHaveLength(12)
  })
})

describe('merging words and meaning', () => {
  const rows = (idx: number) => row(idx)

  it('a sentence found by words inside a window found by meaning is one moment, boosted and ranked by both', () => {
    const fused = fuse([lex(4, 0.7)], [win(3, 5, 0.95)], 0.8, rows)
    expect(fused).toHaveLength(1)
    expect(fused[0]!.from).toBe('both')
    expect(fused[0]!.score).toBeGreaterThan(0.7)
    expect(fused[0]!.matched).toEqual([20])
    expect(fused[0]!.rrf).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1))
  })

  it('a window with no lexical sentence in it stands alone, with no matched words', () => {
    const fused = fuse([lex(1, 0.9)], [win(8, 10, 0.95)], 0.8, rows)
    const alone = fused.find((h) => h.from === 'semantic')!
    expect(alone.matched).toEqual([])
    // It is the window as one clip: it starts on the first sentence's first word and ends on the last sentence's last.
    expect(alone.sentence).toMatchObject({ idx: 8, from: 40, to: 55, start: 48, end: 65 })
  })

  it('a match by meaning alone never outranks a strong match on the words', () => {
    const fused = fuse([lex(1, 0.9)], [win(8, 10, 1)], 0.8, rows)
    const lexical = fused.find((h) => h.from === 'lexical')!
    const semantic = fused.find((h) => h.from === 'semantic')!
    expect(lexical.score).toBeGreaterThan(semantic.score)
    expect(semantic.score).toBeLessThanOrEqual(0.85 + 1e-9)
  })

  it('a stronger meaning match scores higher than a weaker one', () => {
    const fused = fuse([], [win(0, 2, 0.98), win(6, 8, 0.85)], 0.8, rows)
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score)
  })

  it('orders by reciprocal rank fusion: the moment both lists like beats one only a list likes', () => {
    const fused = fuse([lex(4, 0.6), lex(20, 0.95)], [win(3, 5, 0.9), win(30, 32, 0.99)], 0.8, rows)
    expect(fused[0]!.sentence.idx).toBe(4)
  })

  it('has only the words when there is no window, and only the windows when there is no word match', () => {
    expect(fuse([lex(1, 0.8)], [], 0.8, rows).map((h) => h.from)).toEqual(['lexical'])
    expect(fuse([], [win(1, 3, 0.9)], 0.8, rows).map((h) => h.from)).toEqual(['semantic'])
    expect(fuse([], [], 0.8, rows)).toEqual([])
  })

  it('skips a window whose sentences cannot be found, rather than guessing', () => {
    expect(fuse([], [win(1, 3, 0.9)], 0.8, () => undefined)).toEqual([])
  })

  it('is deterministic when scores tie', () => {
    const a = fuse([lex(7, 0.8), lex(2, 0.8)], [], 0.8, rows)
    expect(a.map((h) => h.sentence.idx)).toEqual([2, 7])
  })
})

interface Body {
  input: string[]
  model: string
  dimensions: number
}

describe('a hosted embedding service', () => {
  const dims = 384
  const vec = (x: number) => Array.from({ length: dims }, (_, i) => (i === 0 ? x : 0))
  const make = (
    respond: (body: Body) => Response,
    over: Partial<ConstructorParameters<typeof HostedEmbeddingProvider>[0]> = {},
  ) => {
    const sent: Array<{ url: string; headers: Headers; body: Body }> = []
    const p = new HostedEmbeddingProvider({
      url: 'https://api.example.com/v1/',
      apiKey: 'k-secret',
      model: 'text-embedding-3-small',
      dimensions: dims,
      similarityFloor: 0.5,
      timeoutMs: 1000,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Body
        sent.push({ url: String(url), headers: new Headers(init?.headers), body })
        return respond(body)
      },
      ...over,
    })
    return { p, sent }
  }
  const ok = (body: { input: string[] }) =>
    new Response(
      JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: vec(2) })) }),
      { status: 200 },
    )

  it('posts to /embeddings with the key, the model and the size it needs', async () => {
    const { p, sent } = make(ok)
    await p.embed(['one', 'two'], 'passage')
    expect(sent[0]!.url).toBe('https://api.example.com/v1/embeddings')
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer k-secret')
    expect(sent[0]!.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['one', 'two'],
      dimensions: dims,
    })
  })

  it('returns unit-length vectors in the order of the texts, whatever order the service answered in', async () => {
    const { p } = make(
      (body) =>
        new Response(
          JSON.stringify({
            data: [...body.input].reverse().map((_t: string, k: number) => ({
              index: body.input.length - 1 - k,
              embedding: vec(body.input.length - k),
            })),
          }),
          { status: 200 },
        ),
    )
    const out = await p.embed(['a', 'b', 'c'], 'query')
    expect(out).toHaveLength(3)
    for (const v of out) expect(Math.hypot(...v)).toBeCloseTo(1)
  })

  it('sends a long list in batches', async () => {
    const { p, sent } = make(ok)
    const out = await p.embed(
      Array.from({ length: 150 }, (_, i) => `t${i}`),
      'passage',
    )
    expect(out).toHaveLength(150)
    expect(sent.map((s) => s.body.input.length)).toEqual([64, 64, 22])
  })

  it.each([
    [429, 'rate_limited'],
    [500, 'server'],
    [401, 'unauthorized'],
    [400, 'bad_request'],
  ])('status %i becomes %s, without the key or the text in the message', async (status, kind) => {
    const { p } = make(() => new Response('{"error":"secret text"}', { status }))
    const e = await p.embed(['secret text'], 'query').catch((x: unknown) => x as LlmError)
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).kind).toBe(kind)
    expect((e as LlmError).message).not.toMatch(/secret|k-secret/)
  })

  it('refuses vectors of the wrong size, a short answer and an unreadable one', async () => {
    const wrongSize = make(
      () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), {
          status: 200,
        }),
    )
    await expect(wrongSize.p.embed(['x'], 'query')).rejects.toMatchObject({ kind: 'malformed' })
    const short = make(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    await expect(short.p.embed(['x'], 'query')).rejects.toMatchObject({ kind: 'malformed' })
    const junk = make(() => new Response('not json', { status: 200 }))
    await expect(junk.p.embed(['x'], 'query')).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('a service that cannot be reached is unavailable, one that is too slow is a timeout', async () => {
    const down = make(() => {
      throw new TypeError('fetch failed')
    })
    await expect(down.p.embed(['x'], 'query')).rejects.toMatchObject({ kind: 'unavailable' })
    const slow = new HostedEmbeddingProvider({
      url: 'https://x',
      apiKey: 'k',
      model: 'm',
      dimensions: dims,
      similarityFloor: 0.5,
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)),
        ),
    })
    await expect(slow.embed(['x'], 'query')).rejects.toMatchObject({ kind: 'timeout' })
  })
})

describe('choosing the embedding provider', () => {
  const base = {
    EMBEDDING_PROVIDER: 'auto' as const,
    EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
    EMBEDDING_MODEL_DIR: '/nonexistent',
    EMBEDDING_API_URL: undefined,
    EMBEDDING_API_KEY: undefined,
    EMBEDDING_API_MODEL: 'text-embedding-3-small',
    EMBEDDING_SIMILARITY_FLOOR: undefined,
  }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('auto uses the offline stand-in, and says so, when the model has not been downloaded', () => {
    const p = createEmbeddings(base, log)
    expect(p).toBeInstanceOf(FakeEmbeddingProvider)
    expect(log.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('not downloaded'),
    )
  })

  it('auto uses the model on this machine once it is there', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'emb-'))
    mkdirSync(path.join(dir, 'Xenova', 'multilingual-e5-small'), { recursive: true })
    writeFileSync(path.join(dir, 'Xenova', 'multilingual-e5-small', 'config.json'), '{}')
    expect(hasModel(dir, base.EMBEDDING_MODEL)).toBe(true)
    const p = createEmbeddings({ ...base, EMBEDDING_MODEL_DIR: dir }, log)
    expect(p).toBeInstanceOf(TransformersEmbeddingProvider)
    expect(p).toMatchObject({
      dimensions: 384,
      similarityFloor: 0.8,
      model: 'Xenova/multilingual-e5-small',
    })
  })

  it('can be told which, and to use a different similarity floor', () => {
    expect(createEmbeddings({ ...base, EMBEDDING_PROVIDER: 'fake' }, log)).toBeInstanceOf(
      FakeEmbeddingProvider,
    )
    expect(createEmbeddings({ ...base, EMBEDDING_PROVIDER: 'local' }, log)).toBeInstanceOf(
      TransformersEmbeddingProvider,
    )
    expect(
      createEmbeddings(
        { ...base, EMBEDDING_PROVIDER: 'fake', EMBEDDING_SIMILARITY_FLOOR: 0.42 },
        log,
      ).similarityFloor,
    ).toBe(0.42)
    const hosted = createEmbeddings(
      {
        ...base,
        EMBEDDING_PROVIDER: 'hosted',
        EMBEDDING_API_URL: 'https://x',
        EMBEDDING_API_KEY: 'k',
      },
      log,
    )
    expect(hosted).toBeInstanceOf(HostedEmbeddingProvider)
    expect(hosted.dimensions).toBe(384)
  })

  it('does not look for a model that is not there', () => {
    expect(hasModel('/nonexistent', 'a/b')).toBe(false)
  })
})
