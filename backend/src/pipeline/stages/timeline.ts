import { asc, eq } from 'drizzle-orm'
import { scenes, timelines, timelineVersions } from '../../db/schema/index.js'
import { buildInitialTimeline } from '@lypcut/timeline-core'
import type { Stage } from '../context.js'

/**
 * Stage 7: the timeline the editor opens with: one video clip and one voice clip per scene, on the
 * multi-track layout the editor expects, with captions left empty on purpose. It becomes version 0 ("Original
 * upload"), the root of the history that undo, redo and restore all work from.
 */
export const timelineStage: Stage = {
  key: 'timeline',
  step: 3,
  from: 95,
  to: 99,
  async run(ctx) {
    const { db } = ctx.deps.database
    const rows = await db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, ctx.project.id))
      .orderBy(asc(scenes.idx))
    const sourceDuration = Number(ctx.prior.probe?.durationSec)

    const timeline = buildInitialTimeline(
      rows.map((s) => ({ id: `s${s.idx}`, label: s.label, start: s.startSec, end: s.endSec })),
      sourceDuration,
    )
    const nothing = { type: 'batch', ops: [] }

    await db.transaction(async (tx) => {
      await tx.delete(timelines).where(eq(timelines.projectId, ctx.project.id))
      const [row] = await tx
        .insert(timelines)
        .values({ projectId: ctx.project.id, sourceDuration })
        .returning({ id: timelines.id })
      await tx.insert(timelineVersions).values({
        timelineId: row!.id,
        n: 0,
        parentN: null,
        createdBy: 'user',
        label: 'Original upload',
        snapshot: timeline as unknown as Record<string, unknown>,
        op: nothing,
        inverse: nothing,
      })
    })
    return { items: Object.keys(timeline.items).length, tracks: timeline.tracks.length }
  },
}
