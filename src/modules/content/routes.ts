import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { idParam } from '../projects/schema.js'
import {
  assetListQuery,
  assetListResponse,
  assetParam,
  assetUrlResponse,
  chapterSchema,
  highlightSchema,
  sceneSchema,
  summarySchema,
  transcriptQuery,
  transcriptSchema,
} from './schema.js'
import { ContentService } from './service.js'

/**
 * What the editor reads. Nothing here changes anything, and video bytes never pass through: files are links.
 *   GET /projects/:id/transcript[?from=&to=]  words, speakers, sentences (whole, or a time range)
 *   GET /projects/:id/scenes | highlights | chapters
 *   GET /projects/:id/summary                 counts and where the edit stands
 *   GET /projects/:id/assets[?kind=]          files with short-lived links
 *   GET /projects/:id/assets/:assetId/url     a fresh link for one file
 */
export const contentRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ContentService(app.deps)
  const auth = { onRequest: app.authenticate }

  app.get(
    '/projects/:id/transcript',
    {
      ...auth,
      schema: {
        params: idParam,
        querystring: transcriptQuery,
        response: { 200: transcriptSchema },
      },
    },
    async (req) => {
      const { from, to } = req.query
      return service.transcript(
        req.user!.id,
        req.params.id,
        from === undefined || to === undefined ? undefined : { from, to },
      )
    },
  )

  app.get(
    '/projects/:id/scenes',
    { ...auth, schema: { params: idParam, response: { 200: z.array(sceneSchema) } } },
    async (req) => service.scenes(req.user!.id, req.params.id),
  )

  app.get(
    '/projects/:id/highlights',
    { ...auth, schema: { params: idParam, response: { 200: z.array(highlightSchema) } } },
    async (req) => service.highlights(req.user!.id, req.params.id),
  )

  app.get(
    '/projects/:id/chapters',
    { ...auth, schema: { params: idParam, response: { 200: z.array(chapterSchema) } } },
    async (req) => service.chapters(req.user!.id, req.params.id),
  )

  app.get(
    '/projects/:id/summary',
    { ...auth, schema: { params: idParam, response: { 200: summarySchema } } },
    async (req) => service.summary(req.user!.id, req.params.id),
  )

  app.get(
    '/projects/:id/assets',
    {
      ...auth,
      schema: {
        params: idParam,
        querystring: assetListQuery,
        response: { 200: assetListResponse },
      },
    },
    async (req) => service.assets(req.user!.id, req.params.id, req.query.kind),
  )

  app.get(
    '/projects/:id/assets/:assetId/url',
    { ...auth, schema: { params: assetParam, response: { 200: assetUrlResponse } } },
    async (req) => service.assetUrl(req.user!.id, req.params.id, req.params.assetId),
  )
}
