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
