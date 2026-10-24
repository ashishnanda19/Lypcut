import { and, desc, eq, lt } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import {
  assets,
  projects,
  timelineOps,
  timelines,
  timelineVersions,
} from '../../db/schema/index.js'
import { AppError, err } from '../../lib/errors.js'
import { requireProject } from '../../lib/ownership.js'
import { isEmptyPatch, patchBetween } from '../../timeline-core/equality.js'
import { applyOp, OpError, sequentialIds } from '../../timeline-core/ops.js'
import { otioString } from '../../timeline-core/otio.js'
import type { Timeline, TimelineOp } from '../../timeline-core/types.js'
import type { TimelineState, VersionDto } from './schema.js'

type Db = AppDeps['database']['db']
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type TimelineRow = typeof timelines.$inferSelect
type VersionRow = typeof timelineVersions.$inferSelect

/** A single version's snapshot is stored in full; this keeps one runaway edit from storing something enormous. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export interface CommitInput {
  baseVersion: number
  ops: TimelineOp[]
  label: string
  author: 'you' | 'ai'
  editId?: string
}

const toAuthor = (a: VersionRow['createdBy']): 'you' | 'ai' => (a === 'assistant' ? 'ai' : 'you')
const fromAuthor = (a: 'you' | 'ai'): VersionRow['createdBy'] => (a === 'ai' ? 'assistant' : 'user')

/**
 * The server's copy of each project's edit, and the only place it changes. Every edit (the user's, and later
 * the assistant's) is a list of TimelineOps that passes through the same engine (`applyOp`), which validates it and
 * computes its inverse, inside one database transaction that also checks the client was looking at the latest
 * version. So the stored timeline is always a state the engine produced, history is always complete, and two
 * windows editing at once cannot silently overwrite each other.
 *
 * This service knows nothing about HTTP: the assistant will call `commit` directly.
 */
export class TimelineService {
  constructor(private readonly deps: AppDeps) {}

  private get db() {
    return this.deps.database.db
  }

  /* ------------------------------- reads ------------------------------- */

  async getState(userId: string, projectId: string): Promise<TimelineState> {
    await requireProject(this.db, userId, projectId)
    const row = await this.timelineOf(this.db, projectId)
    return this.stateOf(this.db, row)
  }

  async history(
    userId: string,
    projectId: string,
    opts: { limit: number; before?: number },
  ): Promise<{ current: number; versions: VersionDto[]; hasMore: boolean }> {
    await requireProject(this.db, userId, projectId)
    const tl = await this.timelineOf(this.db, projectId)

    // Cheap columns only: no snapshots, no ops.
    const rows = await this.db
      .select({
        n: timelineVersions.n,
        parentN: timelineVersions.parentN,
        createdBy: timelineVersions.createdBy,
        label: timelineVersions.label,
        editId: timelineVersions.editId,
        createdAt: timelineVersions.createdAt,
      })
      .from(timelineVersions)
      .where(
        and(
          eq(timelineVersions.timelineId, tl.id),
          opts.before === undefined ? undefined : lt(timelineVersions.n, opts.before),
        ),
      )
      .orderBy(desc(timelineVersions.n))
      .limit(opts.limit + 1)

    const parents = await this.parentMap(this.db, tl.id)
    const branch = new Set<number>()
    for (let n: number | null = tl.currentVersion; n !== null; n = parents.get(n) ?? null)
      branch.add(n)
    const redoable = new Set(tl.redoStack)

    const page = rows.slice(0, opts.limit)
    return {
      current: tl.currentVersion,
      hasMore: rows.length > opts.limit,
      versions: page.map((r) => ({
        id: `v_${r.n}`,
        n: r.n,
        parentN: r.parentN,
        author: toAuthor(r.createdBy),
        label: r.label,
        at: r.createdAt.getTime(),
        ...(r.editId ? { editId: r.editId } : {}),
        current: r.n === tl.currentVersion,
        onBranch: branch.has(r.n),
        redoable: redoable.has(r.n),
      })),
    }
  }

  /** One version in full: what it changed, how to undo it, and the timeline as it stood after it. */
  async getVersion(userId: string, projectId: string, n: number) {
    await requireProject(this.db, userId, projectId)
    const tl = await this.timelineOf(this.db, projectId)
    const [row] = await this.db
      .select()
      .from(timelineVersions)
      .where(and(eq(timelineVersions.timelineId, tl.id), eq(timelineVersions.n, n)))
    if (!row) throw err.notFound('Version')
    const parents = await this.parentMap(this.db, tl.id)
    return {
      version: this.dto(row, tl, parents),
      op: row.op as unknown as TimelineOp,
      inverse: row.inverse as unknown as TimelineOp,
      timeline: row.snapshot as unknown as Timeline,
    }
  }

  /* ------------------------------- writes ------------------------------ */

  async applyOps(userId: string, projectId: string, input: CommitInput) {
    await requireProject(this.db, userId, projectId)
    return this.db.transaction(async (tx) => {
      const tl = await this.lockTimeline(tx, projectId)
      this.assertBase(tl, input.baseVersion)
      const base = await this.snapshotOf(tx, tl.id, tl.currentVersion)
      return this.commit(tx, tl, base, input)
    })
  }

  async undo(userId: string, projectId: string, baseVersion: number): Promise<TimelineState> {
    await requireProject(this.db, userId, projectId)
    return this.db.transaction(async (tx) => {
      const tl = await this.lockTimeline(tx, projectId)
      this.assertBase(tl, baseVersion)
      const [current] = await tx
        .select({ parentN: timelineVersions.parentN })
        .from(timelineVersions)
        .where(
          and(eq(timelineVersions.timelineId, tl.id), eq(timelineVersions.n, tl.currentVersion)),
        )
      if (!current || current.parentN === null) {
        throw err.conflict('CONFLICT', 'There is nothing to undo.')
      }
      const [updated] = await tx
        .update(timelines)
        .set({ currentVersion: current.parentN, redoStack: [...tl.redoStack, tl.currentVersion] })
        .where(eq(timelines.id, tl.id))
        .returning()
      await this.touchProject(tx, projectId)
      return this.stateOf(tx, updated!)
    })
  }

  async redo(userId: string, projectId: string, baseVersion: number): Promise<TimelineState> {
    await requireProject(this.db, userId, projectId)
    const result = await this.db.transaction(async (tx) => {
      const tl = await this.lockTimeline(tx, projectId)
      this.assertBase(tl, baseVersion)
      const target = tl.redoStack[tl.redoStack.length - 1]
      if (target === undefined) return { nothing: true as const }
      // A redo is only meaningful from the version it was undone from. Anything else means the stack is stale.
      const [row] = await tx
        .select({ parentN: timelineVersions.parentN })
        .from(timelineVersions)
        .where(and(eq(timelineVersions.timelineId, tl.id), eq(timelineVersions.n, target)))
      if (!row || row.parentN !== tl.currentVersion) {
        // Discard it. This has to be committed, so the refusal is raised after the transaction, not inside it.
        await tx.update(timelines).set({ redoStack: [] }).where(eq(timelines.id, tl.id))
        return { nothing: true as const }
      }
      const [updated] = await tx
        .update(timelines)
        .set({ currentVersion: target, redoStack: tl.redoStack.slice(0, -1) })
        .where(eq(timelines.id, tl.id))
        .returning()
      await this.touchProject(tx, projectId)
      return { state: await this.stateOf(tx, updated!) }
    })
    if ('nothing' in result) throw err.conflict('CONFLICT', 'There is nothing to redo.')
    return result.state
  }

  /**
   * Makes the timeline look like an earlier version. Non-destructive: it adds a new version whose change is "become
   * that one", so nothing in the history is lost and the restore itself can be undone.
   */
  async restore(userId: string, projectId: string, baseVersion: number, versionN: number) {
    await requireProject(this.db, userId, projectId)
    return this.db.transaction(async (tx) => {
      const tl = await this.lockTimeline(tx, projectId)
      this.assertBase(tl, baseVersion)
      const [target] = await tx
        .select()
        .from(timelineVersions)
        .where(and(eq(timelineVersions.timelineId, tl.id), eq(timelineVersions.n, versionN)))
      if (!target) throw err.notFound('Version')

      const base = await this.snapshotOf(tx, tl.id, tl.currentVersion)
      const patch = patchBetween(base, target.snapshot as unknown as Timeline)
      if (isEmptyPatch(patch)) throw err.conflict('CONFLICT', 'This is already how the edit looks.')
      return this.commit(tx, tl, base, {
        baseVersion,
        ops: [patch],
        label: `Restored: ${target.label}`,
        author: 'you',
      })
    })
  }

  /* ------------------------------- OTIO ------------------------------- */

  /** The current timeline as an OpenTimelineIO file, with a download name safe for any header. */
  async exportOtio(userId: string, projectId: string) {
    const project = await requireProject(this.db, userId, projectId)
    const tl = await this.timelineOf(this.db, projectId)
    const timeline = await this.snapshotOf(this.db, tl.id, tl.currentVersion)
    const [raw] = await this.db
      .select({ label: assets.label })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.kind, 'raw')))
    // Point the clips at the original's file name, so an editor relinking media finds the obvious file.
    const mediaName = raw ? raw.label.replace(/[\\/]/g, '_') : 'source.mp4'
    return {
      body: otioString(timeline, project.title, `media/${mediaName}`),
      title: project.title,
    }
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * Applies ops and writes a new version, inside the caller's transaction (which holds the timeline row locked).
   * Ops run in order on a running copy; if any is invalid the whole request fails and nothing is written.
   */
  private async commit(tx: Tx, tl: TimelineRow, base: Timeline, input: CommitInput) {
    const n = tl.lastVersion + 1
    // Ids for the clips ops create depend only on the version number, so the same edit always yields the same ids.
    const newId = sequentialIds(`i_v${n}_`)

    let current = base
    const steps: Array<{ op: TimelineOp; inverse: TimelineOp }> = []
    for (const [i, op] of input.ops.entries()) {
      try {
        const r = applyOp(current, op, { newId })
        steps.push({ op, inverse: r.inverse })
        current = r.timeline
      } catch (e) {
        if (e instanceof OpError) {
          throw new AppError(422, 'INVALID_OP', e.message, { opIndex: i, opType: op.type })
        }
        throw e
      }
    }

    const snapshot = JSON.stringify(current)
    if (snapshot.length > MAX_SNAPSHOT_BYTES) {
      throw new AppError(422, 'INVALID_OP', 'That edit would make the project too large to store.')
    }

    const op: TimelineOp =
      input.ops.length === 1 ? input.ops[0]! : { type: 'batch', ops: input.ops, label: input.label }
    const author = fromAuthor(input.author)
    const [version] = await tx
      .insert(timelineVersions)
      .values({
        timelineId: tl.id,
        n,
        parentN: tl.currentVersion,
        createdBy: author,
        label: input.label,
        editId: input.editId,
        snapshot: current as unknown as Record<string, unknown>,
        op: op as unknown as Record<string, unknown>,
        // One patch that undoes the whole request, however many ops it held.
        inverse: patchBetween(current, base) as unknown as Record<string, unknown>,
      })
      .returning()

    await tx.insert(timelineOps).values(
      steps.map((s, seq) => ({
        timelineId: tl.id,
        versionN: n,
        seq,
        actor: author,
        op: s.op as unknown as Record<string, unknown>,
        inverse: s.inverse as unknown as Record<string, unknown>,
      })),
    )

    // A new edit starts a new branch: whatever could have been redone no longer can.
    const [updated] = await tx
      .update(timelines)
      .set({ currentVersion: n, lastVersion: n, redoStack: [] })
      .where(eq(timelines.id, tl.id))
      .returning()
    await this.touchProject(tx, tl.projectId)

    const parents = await this.parentMap(tx, tl.id)
    return {
      version: this.dto(version!, updated!, parents),
      state: await this.stateOf(tx, updated!, current),
    }
  }

  /** Reads and locks the timeline row, so two edits to one project queue up instead of racing. */
  private async lockTimeline(tx: Tx, projectId: string): Promise<TimelineRow> {
    const [row] = await tx
      .select()
      .from(timelines)
      .where(eq(timelines.projectId, projectId))
      .for('update')
    if (!row) throw this.notReady()
    return row
  }

  private async timelineOf(db: Db | Tx, projectId: string): Promise<TimelineRow> {
    const [row] = await db.select().from(timelines).where(eq(timelines.projectId, projectId))
    if (!row) throw this.notReady()
    return row
  }

  private notReady() {
    return new AppError(
      409,
      'NOT_READY',
      'This project is still being prepared. Try again in a moment.',
    )
  }

  private assertBase(tl: TimelineRow, baseVersion: number) {
    if (tl.currentVersion !== baseVersion) {
      throw err.conflict(
        'VERSION_CONFLICT',
        'This project changed since you last loaded it. Reload to see the latest.',
        { currentVersion: tl.currentVersion, lastVersion: tl.lastVersion, baseVersion },
      )
    }
  }

  private async snapshotOf(db: Db | Tx, timelineId: string, n: number): Promise<Timeline> {
    const [row] = await db
      .select({ snapshot: timelineVersions.snapshot })
      .from(timelineVersions)
      .where(and(eq(timelineVersions.timelineId, timelineId), eq(timelineVersions.n, n)))
    if (!row) throw new Error(`timeline ${timelineId} has no version ${n}`)
    return row.snapshot as unknown as Timeline
  }

  private async stateOf(db: Db | Tx, tl: TimelineRow, known?: Timeline): Promise<TimelineState> {
    const timeline = known ?? (await this.snapshotOf(db, tl.id, tl.currentVersion))
    const [current] = await db
      .select({ parentN: timelineVersions.parentN })
      .from(timelineVersions)
      .where(and(eq(timelineVersions.timelineId, tl.id), eq(timelineVersions.n, tl.currentVersion)))
    return {
      version: tl.currentVersion,
      lastVersion: tl.lastVersion,
      canUndo: current?.parentN !== null && current?.parentN !== undefined,
      canRedo: tl.redoStack.length > 0,
      timeline,
    }
  }

  private async parentMap(db: Db | Tx, timelineId: string): Promise<Map<number, number | null>> {
    const rows = await db
      .select({ n: timelineVersions.n, parentN: timelineVersions.parentN })
      .from(timelineVersions)
      .where(eq(timelineVersions.timelineId, timelineId))
    return new Map(rows.map((r) => [r.n, r.parentN]))
  }

  private dto(row: VersionRow, tl: TimelineRow, parents: Map<number, number | null>): VersionDto {
    const branch = new Set<number>()
    for (let n: number | null = tl.currentVersion; n !== null; n = parents.get(n) ?? null)
      branch.add(n)
    return {
      id: `v_${row.n}`,
      n: row.n,
      parentN: row.parentN,
      author: toAuthor(row.createdBy),
      label: row.label,
      at: row.createdAt.getTime(),
      ...(row.editId ? { editId: row.editId } : {}),
      current: row.n === tl.currentVersion,
      onBranch: branch.has(row.n),
      redoable: tl.redoStack.includes(row.n),
    }
  }

  private async touchProject(tx: Tx, projectId: string) {
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId))
  }
}
