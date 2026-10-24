import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { okSchema } from '../account/schema.js'
import { createProjectBody, idParam, projectSchema, renameProjectBody } from './schema.js'
import { ProjectService } from './service.js'

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ProjectService(app.deps, app.log)
  const auth = { onRequest: app.authenticate }

  app.get(
    '/projects',
    { ...auth, schema: { response: { 200: z.array(projectSchema) } } },
    async (req) => service.list(req.user!.id),
  )

  // Creates the project an upload will belong to. The front end then starts the upload (POST /uploads).
  app.post(
    '/projects',
    {
      ...auth,
      schema: { body: createProjectBody, response: { 201: z.object({ project: projectSchema }) } },
    },
    async (req, reply) => {
      const project = await service.create(req.user!, req.body)
      return reply.status(201).send({ project })
    },
  )

  app.get(
    '/projects/:id',
    { ...auth, schema: { params: idParam, response: { 200: projectSchema } } },
    async (req) => service.get(req.user!.id, req.params.id),
  )

  app.patch(
    '/projects/:id',
    {
      ...auth,
      schema: { params: idParam, body: renameProjectBody, response: { 200: projectSchema } },
    },
    async (req) => service.rename(req.user!.id, req.params.id, req.body.title),
  )

  app.delete(
    '/projects/:id',
    { ...auth, schema: { params: idParam, response: { 200: okSchema } } },
    async (req) => {
      await service.delete(req.user!.id, req.params.id)
      return { ok: true as const }
    },
  )
}
