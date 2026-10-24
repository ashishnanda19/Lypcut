import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

const CHECK_TIMEOUT_MS = 2_000

async function check(fn: () => Promise<void>): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)
      }),
    ])
    return 'ok'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

const checks = z.object({
  postgres: z.enum(['ok', 'down']),
  redis: z.enum(['ok', 'down']),
  storage: z.enum(['ok', 'down']),
})

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const noLimit = { rateLimit: false as const }

  // Liveness: the process is up. Never touches dependencies.
  app.get(
    '/health',
    { config: noLimit, schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  )

  // Readiness: safe to send traffic. Fails while a dependency is down or the process is draining.
  app.get(
    '/ready',
    {
      config: noLimit,
      schema: {
        response: {
          200: z.object({ status: z.literal('ready'), checks }),
          503: z.object({ status: z.enum(['not_ready', 'draining']), checks: checks.optional() }),
        },
      },
    },
    async (_req, reply) => {
      if (app.draining) return reply.status(503).send({ status: 'draining' })
      const { database, redis, storage } = app.deps
      const [postgres, redisStatus, storageStatus] = await Promise.all([
        check(() => database.ping()),
        check(async () => {
          await redis.ping()
        }),
        check(() => storage.ping()),
      ])
      const result = { postgres, redis: redisStatus, storage: storageStatus }
      const ok = Object.values(result).every((s) => s === 'ok')
      return reply
        .status(ok ? 200 : 503)
        .send(
          ok
            ? { status: 'ready' as const, checks: result }
            : { status: 'not_ready' as const, checks: result },
        )
    },
  )
}
