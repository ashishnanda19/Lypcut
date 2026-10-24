import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { editPlans, timelines, timelineVersions } from '../db/schema/index.js'
import type { TimelineOp } from '@lypcut/timeline-core'
import type { DraftPlan, PlannerResult } from './types.js'

type Db = Database['db']
type PlanRow = typeof editPlans.$inferSelect

export type PlanStatus = PlanRow['status']

export const toEditPlan = (row: PlanRow): NonNullable<PlannerResult['plan']> => ({
  id: row.id,
  title: row.title,
  description: row.description,
  op: row.op as unknown as TimelineOp,
  strip: row.strip,
  summary: row.summary,
  ...(row.focus !== null ? { focus: row.focus } : {}),
})

/** Saves a plan that has passed the validator's dry run. Nothing is saved before that. */
export async function savePlan(
  db: Db,
  p: { id: string; projectId: string; userId: string; baseVersion: number; draft: DraftPlan },
): Promise<PlanRow> {
  const [row] = await db
    .insert(editPlans)
    .values({
      id: p.id,
      projectId: p.projectId,
      userId: p.userId,
      baseVersion: p.baseVersion,
      op: p.draft.op as unknown as Record<string, unknown>,
      title: p.draft.title,
      description: p.draft.description,
      strip: p.draft.strip,
      summary: p.draft.summary,
      focus: p.draft.focus ?? null,
    })
    .returning()
  return row!
}

export async function getPlan(
  db: Db,
  userId: string,
  projectId: string,
  planId: string,
): Promise<PlanRow | undefined> {
  const [row] = await db
    .select()
    .from(editPlans)
    .where(
      and(
        eq(editPlans.id, planId),
        eq(editPlans.projectId, projectId),
        eq(editPlans.userId, userId),
      ),
    )
  return row
}

/** A project's plans, oldest first, so a reload restores the Edit cards in the order they were made. */
export async function listPlans(db: Db, userId: string, projectId: string): Promise<PlanRow[]> {
  return db
    .select()
    .from(editPlans)
    .where(and(eq(editPlans.projectId, projectId), eq(editPlans.userId, userId)))
    .orderBy(asc(editPlans.createdAt), asc(editPlans.id))
}

/** The version numbers from the first to the current one: the edits that are in effect. */
async function currentChain(db: Db, projectId: string): Promise<{ chain: Set<number> } | null> {
  const [tl] = await db.select().from(timelines).where(eq(timelines.projectId, projectId))
  if (!tl) return null
  const rows = await db
    .select({ n: timelineVersions.n, parentN: timelineVersions.parentN })
    .from(timelineVersions)
    .where(eq(timelineVersions.timelineId, tl.id))
  const parent = new Map(rows.map((r) => [r.n, r.parentN]))
  const chain = new Set<number>()
  for (
    let n: number | null | undefined = tl.currentVersion;
    n !== null && n !== undefined;
    n = parent.get(n)
  )
    chain.add(n)
  return { chain }
}

/**
 * Brings every plan's status in line with where the timeline is now. A plan is `applied` while the version it made is in
 * effect (on the way from the first version to the current one) and was not taken back by a later "undo that" version;
 * once either is not true it is `undone`, and it comes back to `applied` if undo is undone. A plan nobody applied stays
 * `proposed` (or `previewing`, which only the editor sets).
 */
export async function refreshPlanStatuses(db: Db, projectId: string): Promise<void> {
  const here = await currentChain(db, projectId)
  if (!here) return
  const rows = await db
    .select()
    .from(editPlans)
    .where(
      and(eq(editPlans.projectId, projectId), inArray(editPlans.status, ['applied', 'undone'])),
    )
  for (const r of rows) {
    if (r.appliedVersion === null) continue
    const inEffect =
      here.chain.has(r.appliedVersion) &&
      !(r.undoneByVersion !== null && here.chain.has(r.undoneByVersion))
    const status: PlanStatus = inEffect ? 'applied' : 'undone'
    if (status !== r.status)
      await db.update(editPlans).set({ status }).where(eq(editPlans.id, r.id))
  }
}

export async function markApplied(db: Db, planId: string, version: number): Promise<void> {
  await db
    .update(editPlans)
    .set({ status: 'applied', appliedVersion: version, undoneByVersion: null })
    .where(eq(editPlans.id, planId))
}

/** The editor took a plan back by committing its stored inverse as version `version`. */
export async function markUndone(db: Db, planId: string, version: number): Promise<void> {
  await db
    .update(editPlans)
    .set({ status: 'undone', undoneByVersion: version })
    .where(eq(editPlans.id, planId))
}
