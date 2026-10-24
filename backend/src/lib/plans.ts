/**
 * Plan limits live in this one object, not in the code that enforces them. Changing a limit, or
 * adding a plan, is an edit here. Billing is out of scope: nothing here charges anyone.
 */
export interface PlanLimits {
  /** Longest single video, in seconds. */
  maxVideoSeconds: number
  /** Uploads per calendar month (UTC). */
  maxUploadsPerMonth: number
}

export type PlanId = 'free' | 'creator' | 'studio'

export const PLANS: Record<PlanId, PlanLimits> = {
  free: { maxVideoSeconds: 10 * 60, maxUploadsPerMonth: 3 },
  creator: { maxVideoSeconds: 60 * 60, maxUploadsPerMonth: 30 },
  studio: { maxVideoSeconds: 3 * 60 * 60, maxUploadsPerMonth: 300 },
}

/**
 * How many times the configured daily assistant allowance (PLANNER_DAILY_LIMIT) each plan gets. Kept apart from PLANS
 * because those limits are copied onto each project when it is made; this one is read fresh, so a plan change counts at once.
 */
const PLANNER_MULTIPLIER: Record<PlanId, number> = { free: 1, creator: 5, studio: 20 }

export const plannerMultiplier = (plan: PlanId): number => PLANNER_MULTIPLIER[plan]

/**
 * Container timestamps are rarely exact, so a "10 minute" clip can measure 600.04 s. This slack keeps
 * such a file inside a 10 minute limit. Anything meaningfully longer is still refused.
 */
export const DURATION_TOLERANCE_SEC = 1

export const limitsFor = (plan: PlanId): PlanLimits => PLANS[plan]

export const formatDuration = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s === 0 ? `${m} minute${m === 1 ? '' : 's'}` : `${m}:${String(s).padStart(2, '0')}`
}

/** Returns an error message if the video is too long for the plan, otherwise null. */
export function videoLengthProblem(limits: PlanLimits, durationSec: number): string | null {
  if (durationSec <= limits.maxVideoSeconds + DURATION_TOLERANCE_SEC) return null
  return `This video is ${formatDuration(durationSec)} long. Your plan allows videos up to ${formatDuration(limits.maxVideoSeconds)}.`
}

/** Returns an error message if the month's upload allowance is used up, otherwise null. */
export function monthlyUploadsProblem(limits: PlanLimits, usedThisMonth: number): string | null {
  if (usedThisMonth < limits.maxUploadsPerMonth) return null
  return `You have used all ${limits.maxUploadsPerMonth} uploads for this month. They reset on the 1st.`
}

/** Start of the current calendar month, UTC. */
export const startOfMonthUtc = (now = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

/**
 * What the Style feature allows, by plan. Free accounts can use it, with these limits; they are the same for every plan
 * today, and are kept per plan so changing that is an edit here.
 */
export interface StyleLimits {
  /** Reels a person can have uploaded for style learning at once (delete one to add another). */
  maxUploadedReels: number
  /** Longest single Reel, in seconds. */
  maxReelSeconds: number
}

export const STYLE_LIMITS: Record<PlanId, StyleLimits> = {
  free: { maxUploadedReels: 10, maxReelSeconds: 90 },
  creator: { maxUploadedReels: 10, maxReelSeconds: 90 },
  studio: { maxUploadedReels: 10, maxReelSeconds: 90 },
}

export const styleLimitsFor = (plan: PlanId): StyleLimits => STYLE_LIMITS[plan]

/** Returns an error message if the Reel is too long for the plan, otherwise null. */
export function reelLengthProblem(limits: StyleLimits, durationSec: number): string | null {
  if (durationSec <= limits.maxReelSeconds + DURATION_TOLERANCE_SEC) return null
  return `This Reel is ${formatDuration(durationSec)} long. Style Reels can be up to ${formatDuration(limits.maxReelSeconds)}.`
}
