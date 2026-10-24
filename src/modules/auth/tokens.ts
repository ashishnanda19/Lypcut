import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import type { Config } from '../../lib/config.js'

const ISSUER = 'lypcut'
const AUDIENCE = 'lypcut-api'

type TokenConfig = Pick<Config, 'AUTH_ACCESS_SECRET' | 'ACCESS_TOKEN_TTL_SEC'>

const key = (cfg: TokenConfig) => new TextEncoder().encode(cfg.AUTH_ACCESS_SECRET)

/** A short-lived signed JWT. It carries only the user id: everything else is read fresh from the database. */
export async function signAccessToken(cfg: TokenConfig, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(key(cfg))
}

/** Returns the user id, or null for any invalid, expired or tampered token. The algorithm is pinned. */
export async function verifyAccessToken(cfg: TokenConfig, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(cfg), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** 256 random bits. Only the SHA-256 is stored, so a database leak does not leak usable tokens. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
