import { asc, eq } from 'drizzle-orm'
import { chapters, scenes } from '../../db/schema/index.js'
import { labelScene } from '../../transcription/insights.js'
import type { Stage } from '../context.js'

/**
 * Stage: make the project useful the moment it opens. The full-text and fuzzy-match structures on words and sentences are
 * database indexes, built as the transcript was stored; filler flags were set with the words; silences were found with the
 * scenes; highlights and chapters were found by the two stages before this one. What is left is naming each scene after the
 * chapter it sits in, like the editor's samples do.
 */
export const indexStage: Stage = {
  key: 'index',
  step: 3,
  from: 93,
  to: 95,
  async run(ctx) {
    const { db } = ctx.deps.database
    const parts = await db
      .select({ title: chapters.title, start: chapters.startSec, end: chapters.endSec })
      .from(chapters)
      .where(eq(chapters.projectId, ctx.project.id))
      .orderBy(asc(chapters.idx))
    const sceneRows = await db
      .select({ id: scenes.id, idx: scenes.idx, startSec: scenes.startSec })
      .from(scenes)
      .where(eq(scenes.projectId, ctx.project.id))
      .orderBy(asc(scenes.idx))
    // One query at a time: a transaction is a single connection, and it cannot run several statements at once.
    await db.transaction(async (tx) => {
      for (const s of sceneRows) {
        await tx
          .update(scenes)
          .set({ label: labelScene(s.startSec, s.idx, parts) })
          .where(eq(scenes.id, s.id))
      }
    })
    ctx.progress(1)
    return { scenes: sceneRows.length, chapters: parts.length }
  },
}
