import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { idParam } from '../projects/schema.js'
import { applyPlan, plansWithStatus } from '../../planner/apply.js'
import { PlannerLimiter } from '../../planner/limits.js'
import { PlannerService } from '../../planner/service.js'
import { editPlanSchema, plannerResultSchema, questionCardSchema } from '../../planner/types.js'
import { commitResponse } from '../timeline/schema.js'

const MAX_TEXT = 1000

const common = {
  /** Timeline seconds where the playhead is. */
  playhead: z
    .number()
    .min(0)
    .max(24 * 3600)
    .default(0),
  /** Whether to use the person's learned style (later phase; accepted so the editor's request does not change). */
  applyStyle: z.boolean().default(false),
  /** The last few turns, oldest first. */
  history: z
    .array(z.object({ from: z.enum(['user', 'ai']), text: z.string().max(4000) }))
    .max(8)
    .default([]),
}

const messageBody = z.object({
  text: z
    .string()
    .max(MAX_TEXT, `Keep your message under ${MAX_TEXT.toLocaleString('en')} characters.`),
  ...common,
})
const answerBody = z.object({
  question: questionCardSchema,
  optionId: z.string().min(1).max(60),
  ...common,
})
const reelBody = z.object({
  srcFrom: z
    .number()
    .min(0)
    .max(24 * 3600),
  srcTo: z
    .number()
    .min(0)
    .max(24 * 3600),
  title: z.string().max(200).default(''),
  fast: z.boolean().default(true),
  hookScore: z.number().min(0).max(100).optional(),
  ...common,
})
const applyBody = z.object({ baseVersion: z.number().int().min(0) })
const planParam = z.object({ id: z.string(), planId: z.string() })
const planListItem = editPlanSchema.extend({
  status: z.enum(['proposed', 'previewing', 'applied', 'undone']),
})
const usageResponse = z.object({
  plan: z.enum(['free', 'creator', 'studio']),
  planner: z.object({ used: z.number(), limit: z.number(), resetsAt: z.string() }),
})

/**
 *   POST /projects/:id/assistant/messages  a chat message in, a PlannerResult out (text, a question, or an Edit card)
 *   POST /projects/:id/assistant/answers   a tapped answer on a question card (the Reel questions)
 *   POST /projects/:id/assistant/reel      "Make a Reel" from a highlight or a search result
 *   GET  /projects/:id/plans               the Edit cards made so far, with where each stands
 *   POST /projects/:id/plans/:planId/apply apply a plan as an assistant-authored version
 *   GET  /me/usage                         the plan and how much of today's assistant allowance is used
 */
export const assistantRoutes: FastifyPluginAsyncZod = async (app) => {
  const planner = new PlannerService(app.deps, app.log)
  const limiter = new PlannerLimiter(app.deps)
  const auth = { onRequest: app.authenticate }

  /** Runs a request that may use the model, inside the person's allowance. */
  async function limited<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const release = await limiter.acquire(userId)
    try {
      return await run()
    } finally {
      release()
    }
  }

  app.post(
    '/projects/:id/assistant/messages',
    {
      ...auth,
      schema: { params: idParam, body: messageBody, response: { 200: plannerResultSchema } },
    },
    (req) => limited(req.user!.id, () => planner.message(req.user!.id, req.params.id, req.body)),
  )

  app.post(
    '/projects/:id/assistant/answers',
    {
      ...auth,
      schema: { params: idParam, body: answerBody, response: { 200: plannerResultSchema } },
    },
    (req) => limited(req.user!.id, () => planner.answer(req.user!.id, req.params.id, req.body)),
  )

  app.post(
    '/projects/:id/assistant/reel',
    {
      ...auth,
      schema: { params: idParam, body: reelBody, response: { 200: plannerResultSchema } },
    },
    // Building a Reel from a range needs no model, so it is not counted against the allowance.
    (req) => planner.reel(req.user!.id, req.params.id, req.body),
  )

  app.get(
    '/projects/:id/plans',
    { ...auth, schema: { params: idParam, response: { 200: z.array(planListItem) } } },
    (req) => plansWithStatus(app.deps, req.user!.id, req.params.id),
  )

  app.post(
    '/projects/:id/plans/:planId/apply',
    { ...auth, schema: { params: planParam, body: applyBody, response: { 200: commitResponse } } },
    (req) =>
      applyPlan(app.deps, req.user!.id, req.params.id, req.params.planId, req.body.baseVersion),
  )

  app.get('/me/usage', { ...auth, schema: { response: { 200: usageResponse } } }, (req) =>
    limiter.usage(req.user!.id),
  )
}
