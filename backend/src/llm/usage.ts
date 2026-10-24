import { and, eq, gte, ne, notInArray, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { llmUsage } from '../db/schema/index.js'
import { startOfMonthUtc } from '../lib/plans.js'

export type LlmKind = 'planner' | 'highlights' | 'chapters' | 'embed' | 'style'

export interface UsageRow {
  requestId?: string
  userId?: string
  projectId?: string
  kind: LlmKind
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  latencyMs: number
  outcome: string
  degraded: boolean
}

export async function recordUsage(db: Database['db'], row: UsageRow): Promise<void> {
  await db.insert(llmUsage).values(row)
}

/** Estimated spend by everyone since the start of the month (UTC). Calls the offline model made cost nothing. */
export async function spendThisMonth(db: Database['db'], now = new Date()): Promise<number> {
  const [r] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, startOfMonthUtc(now)))
  return Number(r?.total ?? 0)
}

/** Failures that were the service's fault, not the person's: they do not use up an allowance. */
const NOT_THEIR_FAULT = [
  'timeout',
  'unavailable',
  'server',
  'overloaded',
  'rate_limited',
  'unauthorized',
  'bad_request',
]

/**
 * Assistant requests this person has made since `since`: each request counts once however many model calls it took, one that
 * ended because the service failed does not count, and neither does one the offline model answered (configured, or standing
 * in for us): it costs nothing, and the allowance is there to bound cost.
 */
export async function plannerRequestsSince(
  db: Database['db'],
  userId: string,
  since: Date,
): Promise<number> {
  const [r] = await db
    .select({
      n: sql<number>`count(distinct coalesce(${llmUsage.requestId}, ${llmUsage.id}::text))`,
    })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.userId, userId),
        eq(llmUsage.kind, 'planner'),
        eq(llmUsage.degraded, false),
        ne(llmUsage.provider, 'fake'),
        gte(llmUsage.createdAt, since),
        notInArray(llmUsage.outcome, NOT_THEIR_FAULT),
      ),
    )
  return Number(r?.n ?? 0)
}

/** When the oldest counted request since `since` was made: the burst window reopens a minute after it. */
export async function oldestPlannerRequestSince(
  db: Database['db'],
  userId: string,
  since: Date,
): Promise<Date | null> {
  const [r] = await db
    .select({ at: sql<Date | null>`min(${llmUsage.createdAt})` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.userId, userId),
        eq(llmUsage.kind, 'planner'),
        eq(llmUsage.degraded, false),
        ne(llmUsage.provider, 'fake'),
        gte(llmUsage.createdAt, since),
        notInArray(llmUsage.outcome, NOT_THEIR_FAULT),
      ),
    )
  return r?.at ? new Date(r.at) : null
}
