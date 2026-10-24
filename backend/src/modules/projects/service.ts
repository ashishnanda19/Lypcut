import path from 'node:path'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Log } from '../../lib/log.js'
import type { AppDeps } from '../../app/types.js'
import { assets, jobs, projects, uploads, usageEvents } from '../../db/schema/index.js'
import { activeUploads } from '../../lib/deletion.js'
import { err } from '../../lib/errors.js'
import { requireProject } from '../../lib/ownership.js'
import {
  limitsFor,
  monthlyUploadsProblem,
  startOfMonthUtc,
  videoLengthProblem,
  type PlanId,
} from '../../lib/plans.js'
import { projectPrefix } from '../../lib/storage-keys.js'
import { enqueueJob } from '../../queue/enqueue.js'
import type { ProjectDto } from './schema.js'

type ProjectRow = typeof projects.$inferSelect

/** Upload states that still hold a slot: the user may resume them. */
export const ACTIVE_UPLOAD_STATES = ['initiated', 'uploading', 'completing'] as const

export function titleFromFileName(fileName: string): string {
  const base = path.parse(fileName).name.replace(/[._]+/g, ' ').trim()
  return (base || 'Untitled project').slice(0, 120)
}

/** Uploads this month that count against the plan: finished ones plus ones still in flight. */
export async function uploadsUsedThisMonth(
  db: AppDeps['database']['db'],
  userId: string,
  now = new Date(),
): Promise<number> {
  const [done] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.kind, 'upload'),
        sql`${usageEvents.createdAt} >= ${startOfMonthUtc(now)}`,
      ),
    )
  const [inFlight] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploads)
    .where(
      and(
        eq(uploads.userId, userId),
        inArray(uploads.status, [...ACTIVE_UPLOAD_STATES]),
        sql`${uploads.expiresAt} > ${now}`,
      ),
    )
  return (done?.n ?? 0) + (inFlight?.n ?? 0)
}

export class ProjectService {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {}

  private get db() {
    return this.deps.database.db
  }

  /* ------------------------------ reads ------------------------------ */

  async list(userId: string): Promise<ProjectDto[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.ownerId, userId))
      .orderBy(desc(projects.updatedAt))
    return this.toDtos(rows)
  }

  async get(userId: string, projectId: string): Promise<ProjectDto> {
    const row = await requireProject(this.db, userId, projectId)
    return (await this.toDtos([row]))[0]!
  }

  /** Builds the front end's Project shape for a batch of rows with a fixed number of queries. */
  async toDtos(rows: ProjectRow[]): Promise<ProjectDto[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)

    const assetRows = await this.db
      .select()
      .from(assets)
      .where(
        and(
          inArray(assets.projectId, ids),
          inArray(assets.kind, ['raw', 'proxy']),
          ne(assets.status, 'failed'),
        ),
      )

    // The newest processing job for each project (jobId and progress while it runs).
    const jobRows = await this.db
      .selectDistinctOn([jobs.projectId], {
        projectId: jobs.projectId,
        id: jobs.id,
        progress: jobs.progress,
      })
      .from(jobs)
      .where(and(inArray(jobs.projectId, ids), eq(jobs.type, 'processing')))
      .orderBy(jobs.projectId, desc(jobs.createdAt))
    const jobByProject = new Map(jobRows.map((j) => [j.projectId, j]))

    const uploadRows = await this.db
      .selectDistinctOn([uploads.projectId], {
        projectId: uploads.projectId,
        sizeBytes: uploads.sizeBytes,
        parts: uploads.partsReceived,
      })
      .from(uploads)
      .where(inArray(uploads.projectId, ids))
      .orderBy(uploads.projectId, desc(uploads.createdAt))
    const uploadByProject = new Map(uploadRows.map((u) => [u.projectId, u]))

    const { PRESIGN_GET_TTL_SEC } = this.deps.config
    return Promise.all(
      rows.map(async (p) => {
        const mine = assetRows.filter((a) => a.projectId === p.id)
        const dtoAssets = await Promise.all(
          mine.map(async (a) => ({
            id: a.id,
            kind: a.kind === 'proxy' ? ('proxy' as const) : ('raw' as const),
            label: a.label,
            durationSec: a.durationSec ?? 0,
            // Only the playable proxy gets a link; the original stays private.
            ...(a.kind === 'proxy' && a.status === 'ready'
              ? {
                  url: await this.deps.storage.presignGet(a.storageKey, {
                    ttlSec: PRESIGN_GET_TTL_SEC,
                  }),
                }
              : {}),
          })),
        )
        const job = jobByProject.get(p.id)
        const upload = uploadByProject.get(p.id)
        let progress: number | undefined
        if (p.status === 'processing' && job) progress = job.progress
        if (p.status === 'uploading' && upload) {
          const received = upload.parts.reduce((sum, part) => sum + part.size, 0)
          progress = Math.min(100, Math.floor((received / upload.sizeBytes) * 100))
        }
        return {
          id: p.id,
          title: p.title,
          status: p.status,
          durationSec: p.durationSec ?? 0,
          language: p.sourceLanguage,
          thumbSeed: p.thumbSeed,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
          ...(progress !== undefined ? { progress } : {}),
          ...(job ? { jobId: job.id } : {}),
          ...(p.hooksFound !== null ? { hooksFound: p.hooksFound } : {}),
          assets: dtoAssets,
        }
      }),
    )
  }

  /* ----------------------------- writes ------------------------------ */

  /**
   * Creates the project the upload will belong to. The plan's limits are checked now so someone out
   * of uploads finds out before choosing and sending a file, and are snapshotted onto the project.
   */
  async create(
    user: { id: string; plan: PlanId },
    input: { title?: string; fileName: string; durationSec?: number },
  ): Promise<ProjectDto> {
    const limits = limitsFor(user.plan)
    const quota = monthlyUploadsProblem(limits, await uploadsUsedThisMonth(this.db, user.id))
    if (quota) throw err.limit('LIMIT_MONTHLY_UPLOADS', quota, { max: limits.maxUploadsPerMonth })
    if (input.durationSec !== undefined) {
      const tooLong = videoLengthProblem(limits, input.durationSec)
      if (tooLong)
        throw err.limit('LIMIT_VIDEO_LENGTH', tooLong, { maxSeconds: limits.maxVideoSeconds })
    }

    const [row] = await this.db
      .insert(projects)
      .values({
        ownerId: user.id,
        title: input.title ?? titleFromFileName(input.fileName),
        thumbSeed: 'pending',
        planLimits: { ...limits },
      })
      .returning()
    // The placeholder thumbnail is seeded by the project's own id, as in the front end's mock.
    const [seeded] = await this.db
      .update(projects)
      .set({ thumbSeed: row!.id })
      .where(eq(projects.id, row!.id))
      .returning()
    return (await this.toDtos([seeded!]))[0]!
  }

  async rename(userId: string, projectId: string, title: string): Promise<ProjectDto> {
    await requireProject(this.db, userId, projectId)
    const [row] = await this.db
      .update(projects)
      .set({ title })
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
      .returning()
    return (await this.toDtos([row!]))[0]!
  }

  /**
   * Removes the project's rows at once, and its files through a background job. The job row is written
   * in the same transaction as the delete, so the promise to remove the files cannot be lost.
   */
  async delete(userId: string, projectId: string): Promise<void> {
    await requireProject(this.db, userId, projectId)
    await this.deleteProjectRows(userId, projectId)
  }

  /** Shared by the API and by the cleanup sweep that removes abandoned projects. */
  async deleteProjectRows(userId: string, projectId: string): Promise<void> {
    const inFlight = await activeUploads(this.db, { projectId })
    const pipeline = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['queued', 'running'])))

    const cleanup = await this.db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobs)
        .values({
          type: 'delete_project',
          payload: { prefix: projectPrefix(userId, projectId), uploads: inFlight },
        })
        .returning({ id: jobs.id, type: jobs.type })
      await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
      return job!
    })

    // A job that has not started is withdrawn from the queue. One already running notices the project
    // is gone at its next stage and stops (see the processing worker).
    for (const j of pipeline) await this.deps.queues.processing.remove(j.id).catch(() => undefined)
    await enqueueJob(this.deps.queues, cleanup).catch((e) =>
      this.log.error(
        { err: e, jobId: cleanup.id },
        'could not enqueue project cleanup; the sweep will retry',
      ),
    )
  }
}
