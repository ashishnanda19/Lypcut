import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { instagramAccounts, jobs } from '../../db/schema/index.js'
import type { Log } from '../../lib/log.js'
import { enqueueJob } from '../../queue/enqueue.js'

const DAY = 86_400_000
/** Sync every account about weekly: checked daily, so a worker that was down for a day still catches up. */
const SYNC_EVERY_MS = 6 * DAY
/** Start refreshing a token this long before it runs out (it lasts about 60 days, so there are many tries). */
const REFRESH_WINDOW_MS = 10 * DAY

async function queue(
  deps: AppDeps,
  log: Log,
  userId: string,
  type: 'style_sync' | 'style_refresh',
  detail: string,
) {
  const { db } = deps.database
  // One of each at a time per person.
  const [open] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.type, type),
        inArray(jobs.status, ['queued', 'running']),
      ),
    )
    .limit(1)
  if (open) return false
  const [row] = await db.insert(jobs).values({ userId, type, detail }).returning()
  await enqueueJob(deps.queues, row!).catch((e) =>
    log.error({ err: e, jobId: row!.id }, 'could not enqueue a style job; the sweep will retry'),
  )
  return true
}

/** The weekly sync: every connected account that has not been read for six days. */
export async function scheduleSyncs(deps: AppDeps, log: Log, now = new Date()): Promise<number> {
  const due = await deps.database.db
    .select({ userId: instagramAccounts.userId })
    .from(instagramAccounts)
    .where(
      and(
        eq(instagramAccounts.status, 'active'),
        or(
          isNull(instagramAccounts.lastSyncAt),
          lt(instagramAccounts.lastSyncAt, new Date(now.getTime() - SYNC_EVERY_MS)),
        ),
      ),
    )
  let n = 0
  for (const a of due) if (await queue(deps, log, a.userId, 'style_sync', 'Reading your Reels')) n++
  return n
}

/**
 * Keeps tokens alive: one that has run out can no longer be refreshed, so its account is marked as needing to be connected again;
 * one that will run out soon gets a refresh job.
 */
export async function scheduleRefreshes(
  deps: AppDeps,
  log: Log,
  now = new Date(),
): Promise<{ queued: number; expired: number }> {
  const { db } = deps.database
  const expired = await db
    .update(instagramAccounts)
    .set({ status: 'reauth_required', lastError: 'token_expired' })
    .where(and(eq(instagramAccounts.status, 'active'), lt(instagramAccounts.tokenExpiresAt, now)))
    .returning({ id: instagramAccounts.id })
  const soon = await db
    .select({ userId: instagramAccounts.userId })
    .from(instagramAccounts)
    .where(
      and(
        eq(instagramAccounts.status, 'active'),
        lt(instagramAccounts.tokenExpiresAt, new Date(now.getTime() + REFRESH_WINDOW_MS)),
      ),
    )
  let queued = 0
  for (const a of soon)
    if (await queue(deps, log, a.userId, 'style_refresh', 'Renewing your Instagram connection'))
      queued++
  return { queued, expired: expired.length }
}
