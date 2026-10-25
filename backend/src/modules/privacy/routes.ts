import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { jobs } from '../../db/schema/index.js'
import { AppError, err } from '../../lib/errors.js'
import { UUID_RE } from '../../lib/ids.js'
import { readSignedRequest } from '../../style/instagram/deletion.js'
import { StyleService } from '../style/service.js'
import { privacyPage } from './page.js'

/** What marks a job row as one of Meta's deletion confirmations, so the status page cannot be used to look at any other job. */
const CONFIRMATION = 'Instagram data deletion'

/** In development, with no Meta app, requests are signed with this secret, so the callback can still be tried and tested. */
export const DEVELOPMENT_APP_SECRET = 'fake-instagram-app-secret'

/**
 *   GET  /privacy                         the privacy policy, public
 *   POST /privacy/instagram/deletion      Meta's data-deletion callback: a signed request in, a confirmation code and status address out
 *   GET  /privacy/instagram/deletion      that status address
 */
export const privacyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config, database } = app.deps
  const service = new StyleService(app.deps, app.log)

  // Meta posts the signed request as an ordinary form.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    },
  )

  app.get('/privacy', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(privacyPage(config)),
  )

  // Public, so by address. Meta calls this once per deletion; a burst is not Meta.
  const limited = {
    rateLimit: { max: config.STYLE_RATE_LIMIT_PER_MIN, timeWindow: 60_000 },
  }

  app.post('/privacy/instagram/deletion', { config: limited }, async (req, reply) => {
    const secret =
      config.INSTAGRAM_APP_SECRET ??
      (config.NODE_ENV === 'production' ? null : DEVELOPMENT_APP_SECRET)
    if (!secret) throw err.notImplemented('Instagram is not set up on this server.')
    // Meta posts a form. Anything else is not Meta.
    const isForm = String(req.headers['content-type'] ?? '').startsWith(
      'application/x-www-form-urlencoded',
    )
    const parsed = isForm
      ? readSignedRequest(
          (req.body as { signed_request?: unknown } | undefined)?.signed_request,
          secret,
        )
      : null
    // Nothing is done, and nothing is said about why, for a request that is not exactly Meta's.
    if (!parsed) throw new AppError(403, 'FORBIDDEN', 'That request could not be verified.')

    const { matched } = await service.deleteInstagramData(parsed.userId)
    // The confirmation is a finished job row: its id is the code, and no one's id is in it.
    const [job] = await database.db
      .insert(jobs)
      .values({
        type: 'style_deletion',
        status: 'done',
        progress: 100,
        detail: CONFIRMATION,
        result: { matched },
        finishedAt: new Date(),
      })
      .returning({ id: jobs.id })
    const origin = config.INSTAGRAM_REDIRECT_URI
      ? new URL(config.INSTAGRAM_REDIRECT_URI).origin
      : `${req.protocol}://${req.headers.host ?? 'localhost'}`
    return reply.send({
      url: `${origin}/api/privacy/instagram/deletion?code=${job!.id}`,
      confirmation_code: job!.id,
    })
  })

  app.get(
    '/privacy/instagram/deletion',
    { config: limited, schema: { querystring: z.object({ code: z.string().max(64) }) } },
    async (req, reply) => {
      const found = UUID_RE.test(req.query.code)
        ? (
            await database.db
              .select({ status: jobs.status })
              .from(jobs)
              .where(
                and(
                  eq(jobs.id, req.query.code),
                  eq(jobs.detail, CONFIRMATION),
                  isNull(jobs.userId),
                ),
              )
          )[0]
        : undefined
      if (!found) return reply.status(404).send({ status: 'unknown' })
      return reply.send({ status: found.status === 'done' ? 'completed' : 'in_progress' })
    },
  )
}
