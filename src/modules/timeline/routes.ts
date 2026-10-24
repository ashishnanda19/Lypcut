import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { idParam } from '../projects/schema.js'
import {
  applyOpsBody,
  baseVersionBody,
  commitResponse,
  historyQuery,
  historyResponse,
  restoreBody,
  timelineStateSchema,
  versionDetailSchema,
  versionParam,
} from './schema.js'
import { TimelineService } from './service.js'

/**
 *   GET  /projects/:id/timeline                 the current timeline, and the version to send back with the next edit
 *   POST /projects/:id/timeline/ops             apply a batch of ops atomically (one new version)
 *   POST /projects/:id/timeline/undo | redo     move one step back or forward
 *   GET  /projects/:id/timeline/history         the versions (without their snapshots)
 *   GET  /projects/:id/timeline/versions/:n     one version in full
 *   POST /projects/:id/timeline/restore         become an earlier version, as a new version
 *   GET  /projects/:id/export/otio              the current timeline as an OpenTimelineIO file
 */
export const timelineRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new TimelineService(app.deps)
  const auth = { onRequest: app.authenticate }

  app.get(
    '/projects/:id/timeline',
    { ...auth, schema: { params: idParam, response: { 200: timelineStateSchema } } },
    async (req) => service.getState(req.user!.id, req.params.id),
  )

  app.post(
    '/projects/:id/timeline/ops',
    { ...auth, schema: { params: idParam, body: applyOpsBody, response: { 200: commitResponse } } },
    async (req) => service.applyOps(req.user!.id, req.params.id, req.body),
  )

  app.post(
    '/projects/:id/timeline/undo',
    {
      ...auth,
      schema: { params: idParam, body: baseVersionBody, response: { 200: timelineStateSchema } },
    },
    async (req) => service.undo(req.user!.id, req.params.id, req.body.baseVersion),
  )

  app.post(
    '/projects/:id/timeline/redo',
    {
      ...auth,
      schema: { params: idParam, body: baseVersionBody, response: { 200: timelineStateSchema } },
    },
    async (req) => service.redo(req.user!.id, req.params.id, req.body.baseVersion),
  )

  app.get(
    '/projects/:id/timeline/history',
    {
      ...auth,
      schema: { params: idParam, querystring: historyQuery, response: { 200: historyResponse } },
    },
    async (req) => service.history(req.user!.id, req.params.id, req.query),
  )

  app.get(
    '/projects/:id/timeline/versions/:n',
    { ...auth, schema: { params: versionParam, response: { 200: versionDetailSchema } } },
    async (req) => service.getVersion(req.user!.id, req.params.id, req.params.n),
  )

  app.post(
    '/projects/:id/timeline/restore',
    { ...auth, schema: { params: idParam, body: restoreBody, response: { 200: commitResponse } } },
    async (req) =>
      service.restore(req.user!.id, req.params.id, req.body.baseVersion, req.body.versionN),
  )

  app.get(
    '/projects/:id/export/otio',
    { ...auth, schema: { params: idParam } },
    async (req, reply) => {
      const { body, title } = await service.exportOtio(req.user!.id, req.params.id)
      // A download name that is safe in a header: plain ASCII for old clients, the real (possibly Hindi) title for the rest.
      const ascii =
        title
          .replace(/[^\x20-\x7e]/g, '')
          .replace(/["\\/]/g, '')
          .trim() || 'project'
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${ascii}.otio"; filename*=UTF-8''${encodeURIComponent(title)}.otio`,
        )
        .header('cache-control', 'no-store')
        .send(body)
    },
  )
}
