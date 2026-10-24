import { asc, eq } from 'drizzle-orm'
import {
  chapters,
  highlights,
  projects,
  scenes,
  transcriptSentences,
  transcriptWords,
} from '../../db/schema/index.js'
import { findChapters, findHighlights, labelScene } from '../../transcription/insights.js'
import type { Stage } from '../context.js'

/**
 * Stage 6: make the project searchable and useful the moment it opens. The full-text and fuzzy-match
 * structures on words and sentences are database indexes, built as the transcript was stored; filler flags
 * were set with the words; silences were found with the scenes. What is left is the editorial layer: hook
 * candidates, chapters, and naming each scene after the chapter it sits in, like the editor's samples do.
 */
export const indexStage: Stage = {
  key: 'index',
  step: 3,
  from: 85,
  to: 95,
  async run(ctx) {
    const { db } = ctx.deps.database
    const duration = Number(ctx.prior.probe?.durationSec)

    const sentences = await db
      .select({
        from: transcriptSentences.fromWord,
        to: transcriptSentences.toWord,
        start: transcriptSentences.startSec,
        end: transcriptSentences.endSec,
        text: transcriptSentences.text,
        norm: transcriptSentences.norm,
      })
      .from(transcriptSentences)
      .where(eq(transcriptSentences.projectId, ctx.project.id))
      .orderBy(asc(transcriptSentences.idx))
    const words = await db
      .select({ filler: transcriptWords.filler })
      .from(transcriptWords)
      .where(eq(transcriptWords.projectId, ctx.project.id))
      .orderBy(asc(transcriptWords.idx))
    ctx.progress(0.3)

    const hooks = findHighlights(sentences, words, duration)
    const parts = findChapters(sentences, duration)
    const sceneRows = await db
      .select({ id: scenes.id, idx: scenes.idx, startSec: scenes.startSec })
      .from(scenes)
      .where(eq(scenes.projectId, ctx.project.id))
      .orderBy(asc(scenes.idx))
    ctx.progress(0.6)

    await db.transaction(async (tx) => {
      await tx.delete(highlights).where(eq(highlights.projectId, ctx.project.id))
      await tx.delete(chapters).where(eq(chapters.projectId, ctx.project.id))
      if (hooks.length) {
        await tx.insert(highlights).values(
          hooks.map((h, i) => ({
            projectId: ctx.project.id,
            idx: i,
            title: h.title,
            startSec: h.start,
            endSec: h.end,
            hookScore: h.hookScore,
            reason: h.reason,
            thumbSeed: `${ctx.project.id}-hook-${i}`,
            source: 'heuristic',
          })),
        )
      }
      if (parts.length) {
        await tx.insert(chapters).values(
          parts.map((c, i) => ({
            projectId: ctx.project.id,
            idx: i,
            title: c.title,
            startSec: c.start,
            endSec: c.end,
          })),
        )
      }
      // Name each scene after the chapter it starts in (or "Scene N" with no chapters). One query at a time:
      // a transaction is a single connection, and it cannot run several statements at once.
      for (const s of sceneRows) {
        await tx
          .update(scenes)
          .set({ label: labelScene(s.startSec, s.idx, parts) })
          .where(eq(scenes.id, s.id))
      }
      await tx
        .update(projects)
        .set({ hooksFound: hooks.length })
        .where(eq(projects.id, ctx.project.id))
    })

    await ctx.report.update({ found: { hooks: hooks.length } })
    return { highlights: hooks.length, chapters: parts.length }
  },
}
