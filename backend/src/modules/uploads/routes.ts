import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { okSchema } from '../account/schema.js'
import { idParam } from '../projects/schema.js'
import {
  completeUploadBody,
  completeUploadResponse,
  presignPartsBody,
  presignPartsResponse,
  startUploadBody,
  uploadSchema,
} from './schema.js'
import { UploadService } from './service.js'

/**
 * Resumable uploads. The client talks to storage directly with presigned part URLs, so video bytes
 * never pass through this server:
 *   POST   /uploads              start (or resume) an upload for a project
 *   GET    /uploads/:id          state, including which parts storage already has
 *   POST   /uploads/:id/parts    presigned URLs for the parts to send
 *   POST   /uploads/:id/complete stitch the parts, check the file, queue processing
 *   DELETE /uploads/:id          abort
 */
export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new UploadService(app.deps, app.log)
  const auth = { onRequest: app.authenticate }

  app.post(
    '/uploads',
    {
      ...auth,
      schema: {
        body: startUploadBody,
        response: {
          200: z.object({ upload: uploadSchema }),
          201: z.object({ upload: uploadSchema }),
        },
      },
    },
    async (req, reply) => {
      const { upload, resumed } = await service.start(req.user!, req.body)
      // 200 when the same upload was already open and is being resumed, 201 for a new one.
      return reply.status(resumed ? 200 : 201).send({ upload })
    },
  )

  app.get(
    '/uploads/:id',
    { ...auth, schema: { params: idParam, response: { 200: z.object({ upload: uploadSchema }) } } },
    async (req) => ({ upload: await service.get(req.user!.id, req.params.id) }),
  )

  app.post(
    '/uploads/:id/parts',
    {
      ...auth,
      schema: { params: idParam, body: presignPartsBody, response: { 200: presignPartsResponse } },
    },
    async (req) => service.presignParts(req.user!.id, req.params.id, req.body.partNumbers),
  )

  app.post(
    '/uploads/:id/complete',
    {
      ...auth,
      schema: {
        params: idParam,
        body: completeUploadBody,
        response: { 200: completeUploadResponse },
      },
    },
    async (req) => service.complete(req.user!, req.params.id, req.body ?? {}),
  )

  app.delete(
    '/uploads/:id',
    { ...auth, schema: { params: idParam, response: { 200: okSchema } } },
    async (req) => {
      await service.abort(req.user!.id, req.params.id)
      return { ok: true as const }
    },
  )
}
