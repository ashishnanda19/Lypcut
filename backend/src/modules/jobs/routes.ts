import websocket from '@fastify/websocket'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { AppError } from '../../lib/errors.js'
import { idParam } from '../projects/schema.js'
import { jobSchema } from './dto.js'
import { JobHub } from './hub.js'
import { JobService } from './service.js'

/**
 *   GET  /jobs/:id        the job's current state (also the polling fallback)
 *   POST /jobs/:id/retry  retry a failed processing job from the stage that failed
 *   GET  /jobs/ws         WebSocket: send {type:'subscribe', jobId}, receive {type:'job', job}
 */
export const jobRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new JobService(app.deps)
  const hub = new JobHub(app.deps, app.log)
  const auth = { onRequest: app.authenticate }

  // Registered BEFORE the websocket plugin, so it runs first (preClose hooks run in registration order) and
  // sockets get a proper "going away" (1001) instead of the plugin's bare close.
  app.addHook('preClose', async () => hub.close())
  await app.register(websocket, { options: { maxPayload: 4096 } })
  await hub.start()

  // A browser WebSocket cannot set an Authorization header, so it authenticates with the login cookie,
  // which makes the Origin check the cross-site defence here (a page on another site could otherwise
  // open this socket with the visitor's cookies).
  app.get(
    '/jobs/ws',
    {
      websocket: true,
      onRequest: [
        async (req) => {
          const { origin } = req.headers
          if (origin && !app.deps.config.CORS_ORIGINS.includes(origin)) {
            throw new AppError(
              403,
              'FORBIDDEN',
              'This request came from a site we do not recognise.',
            )
          }
        },
        app.authenticate,
      ],
    },
    (socket, req) => hub.attach(socket, req.user!),
  )

  app.get(
    '/jobs/:id',
    { ...auth, schema: { params: idParam, response: { 200: jobSchema } } },
    async (req) => service.get(req.user!.id, req.params.id),
  )

  app.post(
    '/jobs/:id/retry',
    { ...auth, schema: { params: idParam, response: { 200: jobSchema } } },
    async (req) => service.retry(req.user!.id, req.params.id),
  )
}
