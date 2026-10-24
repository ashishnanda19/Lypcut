import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { err } from '../../lib/errors.js'
import { okSchema, userSchema } from '../account/schema.js'
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies, type IssuedTokens } from './cookies.js'
import { AuthService, type AuthResult } from './service.js'

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email is too long.')
  .pipe(z.email('Enter a valid email, like aarav@gmail.com.'))

const signupBody = z.object({
  name: z.string().trim().max(80, 'Use a shorter name.').optional(),
  email,
  password: z
    .string()
    .min(8, 'Choose a password with at least 8 characters.')
    .max(128, 'Use a password of 128 characters or fewer.'),
})

const loginBody = z.object({
  email,
  password: z.string().min(1, 'Enter your password.').max(128),
})

// A browser refreshes with its cookie and sends no body, which Fastify hands to validation as null.
const refreshBody = z.object({ refreshToken: z.string().min(1).max(200).optional() }).nullish()

const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
})
const authResponse = z.object({ user: userSchema, tokens: tokensSchema.optional() })

/**
 * Browsers get tokens as httpOnly cookies, out of reach of page scripts. A non-browser client opts
 * in to receiving them in the response body instead by sending `X-Auth-Mode: bearer`.
 */
const wantsBearer = (req: FastifyRequest) => req.headers['x-auth-mode'] === 'bearer'

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { config } = app.deps
  const service = new AuthService(app.deps)
  const strict = { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: 60_000 } }

  const respond = (req: FastifyRequest, reply: FastifyReply, result: AuthResult) => {
    if (wantsBearer(req)) return { user: result.user, tokens: result.tokens as IssuedTokens }
    setAuthCookies(reply, config, result.tokens)
    return { user: result.user }
  }

  app.post(
    '/signup',
    { config: strict, schema: { body: signupBody, response: { 201: authResponse } } },
    async (req, reply) => {
      const result = await service.signup(req.body, req.headers['user-agent'])
      return reply.status(201).send(respond(req, reply, result))
    },
  )

  app.post(
    '/login',
    { config: strict, schema: { body: loginBody, response: { 200: authResponse } } },
    async (req, reply) => {
      const result = await service.login(req.body, req.headers['user-agent'])
      return respond(req, reply, result)
    },
  )

  app.post(
    '/refresh',
    { config: strict, schema: { body: refreshBody, response: { 200: authResponse } } },
    async (req, reply) => {
      const token = req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE]
      try {
        const result = await service.refresh(token, req.headers['user-agent'])
        return respond(req, reply, result)
      } catch (e) {
        // A dead session: clear the cookies so the browser stops sending them.
        clearAuthCookies(reply, config)
        throw e
      }
    },
  )

  app.post(
    '/logout',
    { schema: { body: refreshBody, response: { 200: okSchema } } },
    async (req, reply) => {
      await service.logout(req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE])
      clearAuthCookies(reply, config)
      return { ok: true as const }
    },
  )

  // The front end has a Google button. Social login is a later phase; this says so clearly.
  app.post('/google', { config: strict }, async () => {
    throw err.notImplemented('Google sign-in is not available yet. Use your email and password.')
  })
}
