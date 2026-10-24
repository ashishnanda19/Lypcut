import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { okSchema } from '../account/schema.js'
import { idParam } from '../projects/schema.js'
import {
  reelMetricSchema,
  styleProfileSchema,
  styleStatusSchema,
  submitUploadBody,
} from './schema.js'
import { StyleService } from './service.js'

/**
 *   GET    /style              the person's style profile (always one: `connected: false` when they have none)
 *   GET    /style/reels        their analysed Reels, best first
 *   GET    /style/status       where learning is: idle, analysing, ready, failed (and, with Instagram, syncing, reauth_required)
 *   POST   /style/upload       learn from the Reels they have uploaded (the videos go through POST /uploads, with no project)
 *   DELETE /style/reels/:id    remove one Reel and work the profile out again
 *   DELETE /style/connect      remove everything Style holds for them
 */
export const styleRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new StyleService(app.deps, app.log)
  const auth = { onRequest: app.authenticate }

  app.get('/style', { ...auth, schema: { response: { 200: styleProfileSchema } } }, (req) =>
    service.profile(req.user!.id),
  )

  app.get(
    '/style/reels',
    { ...auth, schema: { response: { 200: z.array(reelMetricSchema) } } },
    (req) => service.reels(req.user!.id),
  )

  app.get('/style/status', { ...auth, schema: { response: { 200: styleStatusSchema } } }, (req) =>
    service.status(req.user!.id),
  )

  app.post(
    '/style/upload',
    { ...auth, schema: { body: submitUploadBody, response: { 200: styleProfileSchema } } },
    (req) => service.submit(req.user!.id, req.body),
  )

  app.delete(
    '/style/reels/:id',
    { ...auth, schema: { params: idParam, response: { 200: okSchema } } },
    async (req) => {
      await service.deleteReel(req.user!.id, req.params.id)
      return { ok: true as const }
    },
  )

  app.delete(
    '/style/connect',
    { ...auth, schema: { response: { 200: styleProfileSchema } } },
    (req) => service.disconnect(req.user!.id),
  )
}
