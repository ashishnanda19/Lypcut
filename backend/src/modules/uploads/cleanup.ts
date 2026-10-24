import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { projects, uploads } from '../../db/schema/index.js'
import type { Log } from '../../lib/log.js'
import { ProjectService, ACTIVE_UPLOAD_STATES } from '../projects/service.js'
import { StyleService } from '../style/service.js'
import { UploadService } from './service.js'

/** A request that has been 'completing' this long is not coming back (the server died mid-way). */
const STUCK_AFTER_MS = 15 * 60_000
const BATCH = 200

export interface SweepResult {
  expired: number
  stuck: number
  abandonedProjects: number
  /** Style Reels uploaded but never submitted for learning within a day. */
  unsubmittedReels: number
}

/**
 * Housekeeping for uploads, run on a schedule:
 *  - unfinished uploads past their deadline are aborted, so storage stops holding their parts;
 *  - an upload stuck mid-completion is failed and its file removed;
 *  - a project that never got a video (its upload expired or was abandoned) is deleted, files included.
 * Every step is safe to repeat.
 */
export async function sweepUploads(
  deps: AppDeps,
  log: Log,
  now = new Date(),
): Promise<SweepResult> {
  const { db } = deps.database
  const uploadsService = new UploadService(deps, log)
  const projectsService = new ProjectService(deps, log)

  const expiredRows = await db
    .select()
    .from(uploads)
    .where(and(inArray(uploads.status, ['initiated', 'uploading']), lt(uploads.expiresAt, now)))
    .limit(BATCH)
  for (const row of expiredRows) await uploadsService.expire(row)

  const stuckRows = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.status, 'completing'),
        lt(uploads.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    )
    .limit(BATCH)
  for (const row of stuckRows) await uploadsService.failStuck(row)

  // An 'uploading' project older than the upload window, with nothing in flight, is abandoned.
  const cutoff = new Date(now.getTime() - deps.config.UPLOAD_TTL_HOURS * 3600_000)
  const abandoned = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(
      and(
        eq(projects.status, 'uploading'),
        lt(projects.createdAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(uploads)
            .where(
              and(
                eq(uploads.projectId, projects.id),
                inArray(uploads.status, [...ACTIVE_UPLOAD_STATES]),
              ),
            ),
        ),
      ),
    )
    .limit(BATCH)
  for (const p of abandoned) await projectsService.deleteProjectRows(p.ownerId, p.id)

  const unsubmittedReels = await new StyleService(deps, log).sweepUnsubmitted(now)

  const result = {
    expired: expiredRows.length,
    stuck: stuckRows.length,
    abandonedProjects: abandoned.length,
    unsubmittedReels,
  }
  if (result.expired || result.stuck || result.abandonedProjects || result.unsubmittedReels)
    log.info(result, 'upload sweep')
  return result
}
