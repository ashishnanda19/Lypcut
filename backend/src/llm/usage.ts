import { and, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { llmUsage } from '../db/schema/index.js'
import { startOfMonthUtc } from '../lib/plans.js'

export type LlmKind = 'planner' | 'highlights' | 'chapters' | 'embed'

export interface UsageRow {
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

/** Assistant requests this person has made since `since`, not counting the ones the offline fallback answered for us. */
export async function plannerRequestsSince(
  db: Database['db'],
  userId: string,
  since: Date,
): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.userId, userId),
        eq(llmUsage.kind, 'planner'),
        eq(llmUsage.degraded, false),
        gte(llmUsage.createdAt, since),
      ),
    )
  return Number(r?.n ?? 0)
}
