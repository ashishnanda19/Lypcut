import { eq } from 'drizzle-orm'
import { chapters, transcripts } from '../../db/schema/index.js'
import {
  chapterRanges,
  chapterStarts,
  embedSentences,
  titleChapters,
} from '../../highlights/chapters.js'
import { insightsKey, loadInsightInput } from '../../highlights/input.js'
import { loadWindowVectors } from '../../modules/search/semantic.js'
import { languageLabel, type Stage } from '../context.js'
import { PermanentError } from '../errors.js'

/**
 * Stage: split the video into 3 to 8 chapters where the topic changes, and title them. Code finds the boundaries (the
 * sentences just before each point are compared with the ones just after, as vectors, with pauses, new speakers and
 * picture cuts as hints); the model only writes the titles, in one batched call. Keyed by the transcript's hash, like
 * the highlights.
 */
export const chaptersStage: Stage = {
  key: 'chapters',
  step: 3,
  from: 88,
  to: 93,
  async run(ctx) {
    const { db } = ctx.deps.database
    const { config, llm, embeddings } = ctx.deps
    const input = await loadInsightInput(db, ctx.project.id)
    if (!input) throw new PermanentError('The transcript is missing.', 'TRANSCRIPT_MISSING')
    const duration = Number(ctx.prior.probe?.durationSec)
    const key = insightsKey(input.contentHash, duration)

    if (input.chaptersHash === key) {
      const rows = await db
        .select({ id: chapters.id })
        .from(chapters)
        .where(eq(chapters.projectId, ctx.project.id))
      return { cached: true, chapters: rows.length }
    }

    // The vectors made for search double as each sentence's place in the topic: reuse them, and only embed again if they
    // are missing (the embedding stage was skipped).
    const stored = await loadWindowVectors(
      db,
      input.transcriptId,
      embeddings.model,
      input.sentences.length,
    )
    let vectors = stored
    if (!vectors) {
      try {
        vectors = await embedSentences(embeddings, input.sentences)
      } catch (e) {
        // No way to tell topics apart: every sentence looks alike, so chapters fall where speech pauses, the speaker changes
        // or the picture cuts. Still 3 to 8 sensible chapters, and the project does not wait on the embedding service.
        ctx.log.warn(
          { projectId: ctx.project.id, error: e instanceof Error ? e.name : 'unknown' },
          'could not embed sentences for chapters; using pauses and cuts',
        )
        vectors = input.sentences.map(() => [1])
      }
    }
    ctx.progress(0.4)
    const starts = chapterStarts({
      sentences: input.sentences,
      vectors,
      sceneCuts: input.sceneCuts,
      duration,
    })
    const ranges = chapterRanges(input.sentences, starts, duration)

    const { titles, source } = await titleChapters(
      llm,
      ranges,
      input.sentences,
      { durationSec: duration, language: languageLabel(input.language) },
      { userId: ctx.project.ownerId, projectId: ctx.project.id },
      ctx.log,
      config.LLM_MAX_OUTPUT_TOKENS_BATCH,
      config.LLM_EFFORT_BATCH,
    )

    await db.transaction(async (tx) => {
      await tx.delete(chapters).where(eq(chapters.projectId, ctx.project.id))
      if (ranges.length) {
        await tx.insert(chapters).values(
          ranges.map((r, i) => ({
            projectId: ctx.project.id,
            idx: i,
            title: titles[i]!,
            startSec: r.start,
            endSec: r.end,
            source,
          })),
        )
      }
      await tx
        .update(transcripts)
        .set({ chaptersHash: source === 'heuristic' ? null : key })
        .where(eq(transcripts.id, input.transcriptId))
    })
    return { chapters: ranges.length, source }
  },
}
