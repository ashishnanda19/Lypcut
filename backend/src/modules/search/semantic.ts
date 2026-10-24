import { and, asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { sentenceEmbeddings, transcripts } from '../../db/schema/index.js'
import type { EmbeddingProvider } from '../../llm/index.js'

/** Sentences per window. One window per sentence: window `i` is sentences `i` to `i + WINDOW - 1`. */
export const WINDOW = 3
/** Bump when the way windows are cut changes, so stored vectors are made again. */
export const WINDOWS_VERSION = 'w2'
/** Longest text sent to be embedded, in characters. The model reads about 500 tokens; more would only be cut off. */
const MAX_CHARS = 1400

/**
 * A sentence as it was spoken, for a model to read: Hindi words in Devanagari, English words in Roman letters. The
 * transcript's Roman form of Hindi ("hayaring") is for searching by spelling; a multilingual model understands the
 * Devanagari far better.
 */
export function naturalText(
  words: Array<{ text: string; dev: string; language: 'hi' | 'en' }>,
): string {
  return words.map((w) => (w.language === 'hi' && w.dev ? w.dev : w.text)).join(' ')
}

export interface WindowSentence {
  idx: number
  start: number
  end: number
  text: string
}

export interface SentenceWindow {
  first: number
  last: number
  start: number
  end: number
  text: string
}

/** One window per sentence, each covering it and the next two, so every moment is the start of some window. */
export function windowsFor(sentences: WindowSentence[]): SentenceWindow[] {
  return sentences.map((s, i) => {
    const last = Math.min(i + WINDOW - 1, sentences.length - 1)
    const text = sentences
      .slice(i, last + 1)
      .map((x) => x.text)
      .join(' ')
    return {
      first: s.idx,
      last: sentences[last]!.idx,
      start: s.start,
      end: sentences[last]!.end,
      text: text.slice(0, MAX_CHARS),
    }
  })
}

/** What stored vectors were made for: the transcript, the model and how windows were cut. */
export const embeddingsKey = (contentHash: string | null, model: string, dims: number): string =>
  `${contentHash ?? ''}|${model}|${dims}|${WINDOWS_VERSION}`

/** Vectors in pgvector's text form: [0.1,0.2,...]. Numbers only, so nothing here can be anything but numbers. */
export const vectorLiteral = (v: number[]): string =>
  `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`

export async function replaceEmbeddings(
  db: Database['db'],
  ids: { transcriptId: string; projectId: string },
  provider: EmbeddingProvider,
  windows: SentenceWindow[],
  vectors: number[][],
  key: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sentenceEmbeddings).where(eq(sentenceEmbeddings.transcriptId, ids.transcriptId))
    for (let i = 0; i < windows.length; i += 500) {
      await tx.insert(sentenceEmbeddings).values(
        windows.slice(i, i + 500).map((w, k) => ({
          transcriptId: ids.transcriptId,
          projectId: ids.projectId,
          firstSentence: w.first,
          lastSentence: w.last,
          startSec: w.start,
          endSec: w.end,
          embedding: vectors[i + k]!,
          model: provider.model,
        })),
      )
    }
    await tx
      .update(transcripts)
      .set({ embeddingsHash: key })
      .where(eq(transcripts.id, ids.transcriptId))
  })
}

/** The stored vector of every window of a transcript, in sentence order (null if they were not all made). */
export async function loadWindowVectors(
  db: Database['db'],
  transcriptId: string,
  model: string,
  expected: number,
): Promise<number[][] | null> {
  const rows = await db
    .select({ v: sentenceEmbeddings.embedding })
    .from(sentenceEmbeddings)
    .where(
      and(eq(sentenceEmbeddings.transcriptId, transcriptId), eq(sentenceEmbeddings.model, model)),
    )
    .orderBy(asc(sentenceEmbeddings.firstSentence))
  return rows.length === expected && expected > 0 ? rows.map((r) => r.v) : null
}

export interface SemanticWindow {
  first: number
  last: number
  start: number
  end: number
  similarity: number
}

/** The windows of one project closest in meaning to a query vector, nearest first. Exact: a project holds few of them. */
export async function nearestWindows(
  db: Database['db'],
  projectId: string,
  model: string,
  query: number[],
  limit: number,
): Promise<SemanticWindow[]> {
  const q = vectorLiteral(query)
  const rows = await db.execute<{
    first: number
    last: number
    start: number
    end: number
    sim: number
  }>(sql`
    select first_sentence as first, last_sentence as last, start_sec as start, end_sec as end,
           1 - (embedding <=> ${q}::vector) as sim
    from sentence_embeddings
    where project_id = ${projectId} and model = ${model}
    order by embedding <=> ${q}::vector
    limit ${limit}`)
  return rows.rows.map((r) => ({
    first: Number(r.first),
    last: Number(r.last),
    start: Number(r.start),
    end: Number(r.end),
    similarity: Number(r.sim),
  }))
}

/**
 * Remembers recent query vectors, so typing a query again (or the editor asking while the person types) does not embed it
 * again. Small and short-lived: it is only an optimisation.
 */
export class QueryVectorCache {
  private readonly map = new Map<string, { v: number[]; at: number }>()
  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): number[] | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return hit.v
  }

  set(key: string, v: number[]) {
    if (this.ttlMs <= 0) return
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string)
    this.map.set(key, { v, at: this.now() })
  }
}
