import { eq } from 'drizzle-orm'
import { transcriptSentences, transcripts, transcriptWords } from '../../db/schema/index.js'
import { LlmError } from '../../llm/index.js'
import { estimateTokens } from '../../llm/pricing.js'
import { recordUsage } from '../../llm/usage.js'
import {
  embeddingsKey,
  naturalText,
  replaceEmbeddings,
  windowsFor,
} from '../../modules/search/semantic.js'
import type { Stage } from '../context.js'
import { PermanentError } from '../errors.js'

/**
 * Stage: make the video searchable by meaning. Every sentence, with the two after it, becomes a vector (a list of numbers
 * that places the text by what it is about, in Hindi, English or both), stored in Postgres next to the transcript. Keyed by
 * a hash of the transcript and the model, so it is made once. If the embedding service is down the stage is skipped, not
 * failed: search by words still works, and a retry makes the vectors.
 */
export const embed: Stage = {
  key: 'embed',
  step: 3,
  from: 80,
  to: 84,
  async run(ctx) {
    const { db } = ctx.deps.database
    const provider = ctx.deps.embeddings

    const [tr] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, ctx.project.id))
    if (!tr) throw new PermanentError('The transcript is missing.', 'TRANSCRIPT_MISSING')
    const key = embeddingsKey(tr.contentHash, provider.model, provider.dimensions)
    if (tr.embeddingsHash === key) return { cached: true }

    const rows = await db
      .select({
        idx: transcriptSentences.idx,
        from: transcriptSentences.fromWord,
        to: transcriptSentences.toWord,
        start: transcriptSentences.startSec,
        end: transcriptSentences.endSec,
      })
      .from(transcriptSentences)
      .where(eq(transcriptSentences.transcriptId, tr.id))
      .orderBy(transcriptSentences.idx)
    const words = await db
      .select({
        text: transcriptWords.text,
        dev: transcriptWords.dev,
        language: transcriptWords.language,
      })
      .from(transcriptWords)
      .where(eq(transcriptWords.transcriptId, tr.id))
      .orderBy(transcriptWords.idx)
    const sentences = rows.map((r) => ({
      idx: r.idx,
      start: r.start,
      end: r.end,
      text: naturalText(words.slice(r.from, r.to)),
    }))
    if (!sentences.length) return { windows: 0 }
    const windows = windowsFor(sentences)
    ctx.progress(0.1)

    const started = Date.now()
    let vectors: number[][]
    try {
      vectors = await provider.embed(
        windows.map((w) => w.text),
        'passage',
        ctx.signal,
      )
    } catch (e) {
      if (ctx.signal.aborted) throw e
      const kind = e instanceof LlmError ? e.kind : 'unavailable'
      ctx.log.warn(
        { projectId: ctx.project.id, provider: provider.name, error: kind },
        'could not embed the transcript; search will use words only',
      )
      return { skipped: kind }
    }
    if (
      vectors.length !== windows.length ||
      vectors.some((v) => v.length !== provider.dimensions)
    ) {
      ctx.log.warn(
        { projectId: ctx.project.id, provider: provider.name },
        'the embedding provider sent vectors of the wrong shape; skipping',
      )
      return { skipped: 'malformed' }
    }
    ctx.progress(0.8)

    await replaceEmbeddings(
      db,
      { transcriptId: tr.id, projectId: ctx.project.id },
      provider,
      windows,
      vectors,
      key,
    )

    // Recorded like every model call (tokens estimated from the text; a model on this machine costs nothing).
    await recordUsage(db, {
      userId: ctx.project.ownerId,
      projectId: ctx.project.id,
      kind: 'embed',
      provider: provider.name,
      model: provider.model,
      inputTokens: windows.reduce((n, w) => n + estimateTokens(w.text), 0),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - started,
      outcome: 'ok',
      degraded: false,
    }).catch(() => undefined)

    return { windows: windows.length, model: provider.model }
  },
}
