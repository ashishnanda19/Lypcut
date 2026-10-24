import { describe, expect, it } from 'vitest'
import {
  DURATION_TOLERANCE_SEC,
  formatDuration,
  limitsFor,
  monthlyUploadsProblem,
  PLANS,
  startOfMonthUtc,
  videoLengthProblem,
} from '../../src/lib/plans.js'
import { planParts } from '../../src/modules/uploads/service.js'

describe('plan limits', () => {
  it('the free plan is 10 minutes and 3 uploads a month', () => {
    expect(limitsFor('free')).toEqual({ maxVideoSeconds: 600, maxUploadsPerMonth: 3 })
  })

  it('every plan has positive limits and paid plans are never stricter than free', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.maxVideoSeconds).toBeGreaterThan(0)
      expect(plan.maxUploadsPerMonth).toBeGreaterThan(0)
    }
    expect(PLANS.creator.maxVideoSeconds).toBeGreaterThan(PLANS.free.maxVideoSeconds)
    expect(PLANS.studio.maxUploadsPerMonth).toBeGreaterThanOrEqual(PLANS.creator.maxUploadsPerMonth)
  })

  describe('video length', () => {
    const free = limitsFor('free')
    it('allows anything up to the limit, including exactly 10 minutes', () => {
      expect(videoLengthProblem(free, 1)).toBeNull()
      expect(videoLengthProblem(free, 599.9)).toBeNull()
      expect(videoLengthProblem(free, 600)).toBeNull()
    })
    it('tolerates the rounding in container timestamps, and no more', () => {
      expect(videoLengthProblem(free, 600 + DURATION_TOLERANCE_SEC)).toBeNull()
      expect(videoLengthProblem(free, 600 + DURATION_TOLERANCE_SEC + 0.1)).not.toBeNull()
      expect(videoLengthProblem(free, 11 * 60)).toMatch(/11 minutes/)
    })
    it('names the limit in the message', () => {
      expect(videoLengthProblem(free, 20 * 60)).toMatch(/10 minutes/)
    })
    it('a paid plan allows longer videos', () => {
      expect(videoLengthProblem(limitsFor('creator'), 30 * 60)).toBeNull()
      expect(videoLengthProblem(limitsFor('free'), 30 * 60)).not.toBeNull()
    })
  })

  describe('monthly uploads', () => {
    const free = limitsFor('free')
    it('allows the first three and refuses the fourth', () => {
      expect(monthlyUploadsProblem(free, 0)).toBeNull()
      expect(monthlyUploadsProblem(free, 2)).toBeNull()
      expect(monthlyUploadsProblem(free, 3)).toMatch(/all 3 uploads/)
      expect(monthlyUploadsProblem(free, 10)).not.toBeNull()
    })
  })

  it('the month starts on the 1st, UTC', () => {
    expect(startOfMonthUtc(new Date('2026-10-24T23:59:59Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    )
    expect(startOfMonthUtc(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    )
    expect(startOfMonthUtc(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    )
  })

  it('formats durations for people', () => {
    expect(formatDuration(600)).toBe('10 minutes')
    expect(formatDuration(60)).toBe('1 minute')
    expect(formatDuration(125)).toBe('2:05')
  })
})

describe('multipart planning', () => {
  const MiB = 1024 * 1024
  it('uses one part for a small file and the configured size otherwise', () => {
    expect(planParts(3 * MiB, 16)).toEqual({ partSize: 16 * MiB, totalParts: 1 })
    expect(planParts(16 * MiB, 16)).toEqual({ partSize: 16 * MiB, totalParts: 1 })
    expect(planParts(16 * MiB + 1, 16)).toEqual({ partSize: 16 * MiB, totalParts: 2 })
    expect(planParts(100 * MiB, 16).totalParts).toBe(7)
  })

  it('never needs more than the 10,000 parts S3 allows, even for the largest file', () => {
    const eightGiB = 8 * 1024 * MiB
    const { partSize, totalParts } = planParts(eightGiB, 5)
    expect(totalParts).toBeLessThanOrEqual(10_000)
    expect(partSize * totalParts).toBeGreaterThanOrEqual(eightGiB)
    expect(partSize).toBeGreaterThanOrEqual(5 * MiB)
  })

  it('every part but the last is full size and the last is never empty', () => {
    for (const size of [1, 5 * MiB, 5 * MiB + 1, 33 * MiB, 8 * 1024 * MiB - 7]) {
      const { partSize, totalParts } = planParts(size, 5)
      const last = size - partSize * (totalParts - 1)
      expect(last).toBeGreaterThan(0)
      expect(last).toBeLessThanOrEqual(partSize)
    }
  })
})
