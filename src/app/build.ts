import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { loggerOptions } from '../lib/logger.js'
import { healthRoutes } from '../modules/health/routes.js'
import { accountRoutes } from '../modules/account/routes.js'
import { authRoutes } from '../modules/auth/routes.js'
import { projectRoutes } from '../modules/projects/routes.js'
import { uploadRoutes } from '../modules/uploads/routes.js'
import { registerAuth } from './plugins/auth.js'
import { registerDocs } from './plugins/docs.js'
import { registerErrorHandling } from './plugins/errors.js'
import { registerSecurity } from './plugins/security.js'
import type { AppDeps } from './types.js'

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    // Reuse a well-formed id from the caller (a load balancer or the front end), else make one.
    genReqId: (req) => {
      const given = req.headers['x-request-id']
      return typeof given === 'string' && REQUEST_ID_RE.test(given) ? given : randomUUID()
    },
    bodyLimit: 1024 * 1024,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorate('deps', deps)
  app.decorate('draining', false)

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id)
    // Many HTTP clients send `Content-Type: application/json` on every request, including a DELETE
    // with no body. Fastify would reject that as an empty JSON body, so ignore the header when
    // there is no body at all.
    const hasBody =
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
      req.headers['transfer-encoding'] !== undefined
    if (!hasBody) delete req.headers['content-type']
  })
  // Resources are released by whoever created them (server.ts / tests), not here, so a test
  // can build several apps over one set of connections.

  // Security first: the not-found handler below is rate limited too (it is not a normal route).
  await registerSecurity(app)
  registerErrorHandling(app)
  registerAuth(app)
  await registerDocs(app)

  const typed = app.withTypeProvider<ZodTypeProvider>()
  await typed.register(healthRoutes)
  // Feature modules mount under /api; the front end calls relative `/api/...`.
  await typed.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' })
      await api.register(accountRoutes)
      await api.register(projectRoutes)
      await api.register(uploadRoutes)
      // More modules mount here as each step lands.
    },
    { prefix: '/api' },
  )

  return app
}
