import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema/index.js'
import { AppError, err } from '../../lib/errors.js'
import { ACCESS_COOKIE } from '../../modules/auth/cookies.js'
import { verifyAccessToken } from '../../modules/auth/tokens.js'

export interface AuthUser {
  id: string
  email: string
  name: string
  plan: 'free' | 'creator' | 'studio'
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `app.authenticate`. Null on routes that do not require a login. */
    user: AuthUser | null
  }
  interface FastifyInstance {
    /** Use as a route's onRequest hook: rejects with 401 unless the caller is logged in. */
    authenticate: (req: FastifyRequest) => Promise<void>
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function registerAuth(app: FastifyInstance): void {
  const { config, database } = app.deps

  // CSRF defence, on top of SameSite=Lax cookies: a browser always sends Origin on a cross-site
  // write, so one from an origin we do not know is refused. Requests with no Origin (curl, server to
  // server) are not browser-driven, so they cannot be cross-site forgeries.
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return
    const { origin } = req.headers
    const crossSite = req.headers['sec-fetch-site'] === 'cross-site'
    if ((origin && !config.CORS_ORIGINS.includes(origin)) || (!origin && crossSite)) {
      throw new AppError(403, 'FORBIDDEN', 'This request came from a site we do not recognise.')
    }
  })

  app.decorateRequest('user', null)
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const token = bearer ?? req.cookies[ACCESS_COOKIE]
    if (!token) throw err.unauthenticated()

    const userId = await verifyAccessToken(config, token)
    if (!userId) throw err.unauthenticated('Your session expired. Please log in again.')

    // Read the user fresh each time: a deleted account stops working immediately, not when the
    // access token runs out, and the plan is never stale.
    const [user] = await database.db
      .select({ id: users.id, email: users.email, name: users.name, plan: users.plan })
      .from(users)
      .where(eq(users.id, userId))
    if (!user) throw err.unauthenticated()
    req.user = user
  })
}
