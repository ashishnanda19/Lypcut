import { asc, eq } from 'drizzle-orm'
import { transcriptSentences, transcripts, transcriptWords } from '../../src/db/schema/index.js'
import type { EmbeddingKind, EmbeddingProvider } from '../../src/llm/index.js'
import {
  embeddingsKey,
  naturalText,
  replaceEmbeddings,
  windowsFor,
} from '../../src/modules/search/semantic.js'
import type { TestApp } from './app.js'

/**
 * An embedding provider whose notion of meaning the test writes by hand: `topics` says which topic each text is about
 * (by a word it contains), and texts about the same topic get the same direction. So a test can make "ab-initio" mean the
 * same as a sentence about funding, with no word in common, and watch search find it.
 */
let instances = 0

export class TopicEmbeddings implements EmbeddingProvider {
  readonly name = 'topic-test'
  /** Unique per instance, so one test's remembered query vectors are never used by another. */
  readonly model = `topic-test-model-${++instances}`
  readonly dimensions = 384
  readonly similarityFloor = 0.5
  calls = 0
  queries: string[] = []
  fail: Error | null = null

  constructor(private readonly topics: Record<string, string[]>) {}

  /** How many keywords of each topic a text contains. */
  private hits(text: string): number[] {
    const lower = text.toLowerCase()
    return Object.values(this.topics).map(
      (keywords) => keywords.filter((k) => lower.includes(k.toLowerCase())).length,
    )
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<number[][]> {
    this.calls++
    if (this.fail) throw this.fail
    if (kind === 'query') this.queries.push(...texts)
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0)
      const hits = this.hits(t)
      if (hits.some((h) => h > 0)) {
        hits.forEach((h, i) => (v[i] = h))
      } else {
        // About none of the topics: a direction of its own, so it is close to nothing else.
        let h = 7
        for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0
        v[50 + (h % 300)] = 1
      }
      const norm = Math.hypot(...v)
      return v.map((x) => x / norm)
    })
  }
}

/** Stores a vector for every window of a project's transcript, as the pipeline's embed stage does. */
export async function seedEmbeddings(t: TestApp, projectId: string, provider: EmbeddingProvider) {
  const { db } = t.deps.database
  const [tr] = await db.select().from(transcripts).where(eq(transcripts.projectId, projectId))
  const rows = await db
    .select({
      idx: transcriptSentences.idx,
      from: transcriptSentences.fromWord,
      to: transcriptSentences.toWord,
      start: transcriptSentences.startSec,
      end: transcriptSentences.endSec,
    })
    .from(transcriptSentences)
    .where(eq(transcriptSentences.transcriptId, tr!.id))
    .orderBy(asc(transcriptSentences.idx))
  const words = await db
    .select({
      text: transcriptWords.text,
      dev: transcriptWords.dev,
      language: transcriptWords.language,
    })
    .from(transcriptWords)
    .where(eq(transcriptWords.transcriptId, tr!.id))
    .orderBy(asc(transcriptWords.idx))
  const sentences = rows.map((r) => ({
    idx: r.idx,
    start: r.start,
    end: r.end,
    text: naturalText(words.slice(r.from, r.to)),
  }))
  const windows = windowsFor(sentences)
  const vectors = await provider.embed(
    windows.map((w) => w.text),
    'passage',
  )
  await replaceEmbeddings(
    db,
    { transcriptId: tr!.id, projectId },
    provider,
    windows,
    vectors,
    embeddingsKey(tr!.contentHash, provider.model, provider.dimensions),
  )
  return { windows, transcriptId: tr!.id }
}
