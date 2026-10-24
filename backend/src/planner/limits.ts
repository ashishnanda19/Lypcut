import { eq } from 'drizzle-orm'
import type { AppDeps } from '../app/types.js'
import { users } from '../db/schema/index.js'
import { AppError } from '../lib/errors.js'
import { plannerMultiplier } from '../lib/plans.js'
import { oldestPlannerRequestSince, plannerRequestsSince } from '../llm/usage.js'

const DAY_MS = 24 * 3600 * 1000
const MINUTE_MS = 60 * 1000

export interface PlannerUsage {
  plan: 'free' | 'creator' | 'studio'
  planner: {
    used: number
    limit: number
    /** The next UTC midnight, when the day's allowance starts again. */
    resetsAt: string
  }
}

/**
 * How many assistant requests a person may make. Two limits: a daily allowance (so a free account cannot run up model cost)
 * and a burst limit per minute (so a script cannot hammer it). A request counts when a model call was made for it, and
 * not when the service failed or the offline fallback answered, so a hiccup never costs anyone their allowance.
 *
 * Requests still being worked on count against the limits too, so a person cannot start a hundred at once before any of them
 * has been recorded. That count lives in this process: with several API instances a person could get a few extra, never more
 * than the burst limit allows.
 */
export class PlannerLimiter {
  private readonly inflight = new Map<string, number>()

  constructor(private readonly deps: AppDeps) {}

  private get db() {
    return this.deps.database.db
  }

  private startOfDay(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  }

  private async limitFor(userId: string) {
    const [u] = await this.db.select({ plan: users.plan }).from(users).where(eq(users.id, userId))
    const plan = u?.plan ?? 'free'
    return { plan, limit: this.deps.config.PLANNER_DAILY_LIMIT * plannerMultiplier(plan) }
  }

  async usage(userId: string): Promise<PlannerUsage> {
    const { plan, limit } = await this.limitFor(userId)
    const day = this.startOfDay()
    return {
      plan,
      planner: {
        used: await plannerRequestsSince(this.db, userId, day),
        limit,
        resetsAt: new Date(day.getTime() + DAY_MS).toISOString(),
      },
    }
  }

  /**
   * Lets a request through or refuses it with 429 and how long to wait. Call the returned function when the request ends.
   */
  async acquire(userId: string): Promise<() => void> {
    const { limit } = await this.limitFor(userId)
    const mine = this.inflight.get(userId) ?? 0
    const now = new Date()
    const day = this.startOfDay(now)

    const used = (await plannerRequestsSince(this.db, userId, day)) + mine
    if (used >= limit) {
      const resetsAt = new Date(day.getTime() + DAY_MS)
      throw new AppError(
        429,
        'RATE_LIMITED',
        'You have used all of today’s assistant requests. They reset at midnight UTC.',
        {
          retryAfterSec: Math.ceil((resetsAt.getTime() - now.getTime()) / 1000),
          limit,
          used,
          resetsAt: resetsAt.toISOString(),
        },
      )
    }

    const burst = this.deps.config.PLANNER_BURST_PER_MINUTE
    const since = new Date(now.getTime() - MINUTE_MS)
    const recent = (await plannerRequestsSince(this.db, userId, since)) + mine
    if (recent >= burst) {
      const oldest = await oldestPlannerRequestSince(this.db, userId, since)
      const wait = oldest
        ? Math.max(1, Math.ceil((oldest.getTime() + MINUTE_MS - now.getTime()) / 1000))
        : 5
      throw new AppError(
        429,
        'RATE_LIMITED',
        'You are sending requests too quickly. Wait a moment and try again.',
        {
          retryAfterSec: wait,
          limit: burst,
          used: recent,
          window: 'minute',
        },
      )
    }

    this.inflight.set(userId, mine + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.inflight.get(userId) ?? 1) - 1
      if (n <= 0) this.inflight.delete(userId)
      else this.inflight.set(userId, n)
    }
  }
}
