import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { clearAuthCookies } from '../auth/cookies.js'
import { AccountService } from './service.js'
import { okSchema, updateMeBody, userSchema } from './schema.js'

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new AccountService(app.deps, app.log)
  const auth = { onRequest: app.authenticate }
  const userResponse = z.object({ user: userSchema })

  app.get('/me', { ...auth, schema: { response: { 200: userResponse } } }, async (req) => ({
    user: await service.get(req.user!.id),
  }))

  app.patch(
    '/me',
    { ...auth, schema: { body: updateMeBody, response: { 200: userResponse } } },
    async (req) => ({ user: await service.update(req.user!.id, req.body) }),
  )

  // Deletes the account and every project, upload and file that belongs to it.
  app.delete('/me', { ...auth, schema: { response: { 200: okSchema } } }, async (req, reply) => {
    await service.delete(req.user!.id)
    clearAuthCookies(reply, app.deps.config)
    return { ok: true as const }
  })
}
