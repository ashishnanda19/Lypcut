import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../lib/errors.js'
import { createRedis } from '../../queue/connection.js'

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const { config } = app.deps

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  })

  await app.register(cookie)

  // Counters live in Redis so every API instance shares one limit. A dedicated connection fails
  // fast, and skipOnError keeps the API up if Redis blips.
  const limiterRedis = createRedis(config, { connectTimeout: 500, maxRetriesPerRequest: 1 })
  limiterRedis.on('error', () => undefined)
  app.addHook('onClose', async () => {
    limiterRedis.disconnect()
  })
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SEC * 1000,
    redis: limiterRedis,
    nameSpace: 'rl:',
    skipOnError: true,
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', {
        retryAfterSec: Math.ceil(ctx.ttl / 1000),
      }),
  })
}
