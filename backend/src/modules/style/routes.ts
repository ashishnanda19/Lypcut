import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { okSchema } from '../account/schema.js'
import { idParam } from '../projects/schema.js'
import { ACCESS_COOKIE } from '../auth/cookies.js'
import { verifyAccessToken } from '../auth/tokens.js'
import { InstagramOAuth, requireInstagram } from '../../style/instagram/oauth.js'
import {
  callbackQuery,
  connectResponseSchema,
  reelMetricSchema,
  styleProfileSchema,
  styleStatusSchema,
  submitUploadBody,
  syncResponseSchema,
} from './schema.js'
import { FAKE_ACCOUNTS } from '../../style/instagram/fake.js'
import { StyleService } from './service.js'

/**
 *   GET    /style              the person's style profile (always one: `connected: false` when they have none)
 *   GET    /style/reels        their analysed Reels, best first
 *   GET    /style/status       where learning is: idle, analysing, ready, failed (and, with Instagram, syncing, reauth_required)
 *   POST   /style/upload       learn from the Reels they have uploaded (the videos go through POST /uploads, with no project)
 *   POST   /style/connect      start connecting Instagram: where to send the person, and what to tell them first
 *   GET    /style/callback     where Instagram sends them back (public: protected by the single-use state)
 *   POST   /style/sync         read their Instagram again (once an hour)
 *   DELETE /style/reels/:id    remove one Reel and work the profile out again
 *   DELETE /style/connect      remove everything Style holds for them
 */
export const styleRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new StyleService(app.deps, app.log)
  const auth = { onRequest: app.authenticate }

  app.get('/style', { ...auth, schema: { response: { 200: styleProfileSchema } } }, (req) =>
    service.profile(req.user!.id),
  )

  app.get(
    '/style/reels',
    { ...auth, schema: { response: { 200: z.array(reelMetricSchema) } } },
    (req) => service.reels(req.user!.id),
  )

  app.get('/style/status', { ...auth, schema: { response: { 200: styleStatusSchema } } }, (req) =>
    service.status(req.user!.id),
  )

  app.post(
    '/style/upload',
    { ...auth, schema: { body: submitUploadBody, response: { 200: styleProfileSchema } } },
    (req) => service.submit(req.user!.id, req.body),
  )

  app.post(
    '/style/connect',
    { ...auth, schema: { response: { 200: connectResponseSchema } } },
    (req) => service.startConnect(req.user!.id),
  )

  /**
   * Instagram sends the browser here after the person approves or refuses. It is not behind a login (the browser arrives from
   * another site), but nothing happens without the single-use state, and a session that is someone else's is refused. It always
   * answers with a redirect to the Style page, which says what happened.
   */
  app.get('/style/callback', { schema: { querystring: callbackQuery } }, async (req, reply) => {
    const oauth = new InstagramOAuth(app.deps, app.log, requireInstagram(app.deps))
    const token = req.cookies[ACCESS_COOKIE]
    const session = token ? await verifyAccessToken(app.deps.config, token) : null
    const result = await oauth.callback(req.query, session)
    return reply.redirect(oauth.redirectFor(result))
  })

  app.post(
    '/style/sync',
    { ...auth, schema: { response: { 202: syncResponseSchema } } },
    async (req, reply) => reply.status(202).send(await service.triggerSync(req.user!.id)),
  )

  // The stand-in for Instagram's own consent screen, only when the stand-in is the Instagram in use.
  if (app.deps.instagram?.name === 'fake') {
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    app.get(
      '/style/fake-instagram/authorize',
      { schema: { querystring: z.object({ state: z.string().max(256) }) } },
      async (req, reply) => {
        const go = (params: string) =>
          `/api/style/callback?${params}&state=${encodeURIComponent(req.query.state)}`
        const link = (href: string, text: string) =>
          `<p><a href="${esc(href)}">${esc(text)}</a></p>`
        return reply.type('text/html; charset=utf-8')
          .send(`<!doctype html><meta charset="utf-8"><title>Instagram (stand-in)</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Instagram, stand-in</h1>
<p>This page stands in for Instagram's consent screen, because no Meta app is set up. Lypcut would be able to read your Reels and their numbers, and nothing else.</p>
${link(go(`code=${Object.keys(FAKE_ACCOUNTS)[0]}`), 'Continue as a Creator account')}
${link(go(`code=${Object.keys(FAKE_ACCOUNTS)[1]}`), 'Continue as a Business account')}
${link(go(`code=${Object.keys(FAKE_ACCOUNTS)[2]}`), 'Continue as a personal account')}
${link(go('error=access_denied'), 'Cancel')}
</body>`)
      },
    )
  }

  app.delete(
    '/style/reels/:id',
    { ...auth, schema: { params: idParam, response: { 200: okSchema } } },
    async (req) => {
      await service.deleteReel(req.user!.id, req.params.id)
      return { ok: true as const }
    },
  )

  app.delete(
    '/style/connect',
    { ...auth, schema: { response: { 200: styleProfileSchema } } },
    (req) => service.disconnect(req.user!.id),
  )
}
