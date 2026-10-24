import { applyOp, OpError, type TimelineOp } from '@lypcut/timeline-core'
import type { AppDeps } from '../app/types.js'
import { AppError, err } from '../lib/errors.js'
import { requireProject } from '../lib/ownership.js'
import { TimelineService } from '../modules/timeline/service.js'
import { getPlan, listPlans, refreshPlanStatuses, toEditPlan } from './store.js'

/**
 * Applying a plan is an ordinary edit, made by the assistant: the same service as POST /timeline/ops, with the plan's op,
 * author `ai` and the plan's id as the edit's id. If the timeline has moved on since the plan was made, the plan is checked
 * again against the new timeline: still valid, it is applied; no longer valid, the answer is 409 STALE_PLAN and the editor
 * asks the assistant for a fresh plan.
 */
export async function applyPlan(
  deps: AppDeps,
  userId: string,
  projectId: string,
  planId: string,
  baseVersion: number,
) {
  await requireProject(deps.database.db, userId, projectId)
  const timeline = new TimelineService(deps)
  const plan = await getPlan(deps.database.db, userId, projectId, planId)
  if (!plan) throw err.notFound('Plan')
  if (plan.status === 'applied') throw err.conflict('CONFLICT', 'This edit is already applied.')

  const state = await timeline.getState(userId, projectId)
  if (state.version !== plan.baseVersion) {
    try {
      applyOp(state.timeline, plan.op as unknown as TimelineOp)
    } catch (e) {
      if (e instanceof OpError) {
        throw new AppError(
          409,
          'STALE_PLAN',
          'Your edit changed since this plan was made, and it no longer fits. Ask again for a fresh one.',
          {
            planVersion: plan.baseVersion,
            currentVersion: state.version,
          },
        )
      }
      throw e
    }
  }

  return timeline.applyOps(userId, projectId, {
    baseVersion,
    ops: [plan.op as unknown as TimelineOp],
    label: plan.title,
    author: 'ai',
    editId: plan.id,
  })
}

/** A project's plans with where each stands now, so a reload restores the Edit cards. */
export async function plansWithStatus(deps: AppDeps, userId: string, projectId: string) {
  const { db } = deps.database
  await requireProject(db, userId, projectId)
  await refreshPlanStatuses(db, projectId)
  return (await listPlans(db, userId, projectId)).map((row) => ({
    ...toEditPlan(row),
    status: row.status,
  }))
}
