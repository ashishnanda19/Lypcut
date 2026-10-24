import type { FastifyReply } from 'fastify'
import type { Config } from '../../lib/config.js'

export const ACCESS_COOKIE = 'lypcut_at'
export const REFRESH_COOKIE = 'lypcut_rt'
/** The refresh cookie is only sent to the auth routes, so it is not attached to every API call. */
const REFRESH_PATH = '/api/auth'

type CookieConfig = Pick<
  Config,
  'NODE_ENV' | 'COOKIE_SECURE' | 'COOKIE_DOMAIN' | 'ACCESS_TOKEN_TTL_SEC' | 'REFRESH_TOKEN_TTL_SEC'
>

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
}

const base = (cfg: CookieConfig) => ({
  httpOnly: true,
  secure: cfg.COOKIE_SECURE ?? cfg.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  domain: cfg.COOKIE_DOMAIN,
})

export function setAuthCookies(reply: FastifyReply, cfg: CookieConfig, t: IssuedTokens): void {
  reply.setCookie(ACCESS_COOKIE, t.accessToken, {
    ...base(cfg),
    path: '/',
    maxAge: cfg.ACCESS_TOKEN_TTL_SEC,
  })
  reply.setCookie(REFRESH_COOKIE, t.refreshToken, {
    ...base(cfg),
    path: REFRESH_PATH,
    maxAge: cfg.REFRESH_TOKEN_TTL_SEC,
  })
}

export function clearAuthCookies(reply: FastifyReply, cfg: CookieConfig): void {
  const { domain } = base(cfg)
  reply.clearCookie(ACCESS_COOKIE, { path: '/', domain })
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH, domain })
}
