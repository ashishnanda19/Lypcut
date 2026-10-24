import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  hashToken,
  newRefreshToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
} from '../../src/modules/auth/tokens.js'

const cfg = { AUTH_ACCESS_SECRET: 'a'.repeat(40), ACCESS_TOKEN_TTL_SEC: 900 }
const key = (s: string) => new TextEncoder().encode(s)

describe('access tokens', () => {
  it('round-trips the user id', async () => {
    const token = await signAccessToken(cfg, 'user-1')
    expect(await verifyAccessToken(cfg, token)).toBe('user-1')
  })

  it('rejects a token signed with another secret', async () => {
    const token = await signAccessToken({ ...cfg, AUTH_ACCESS_SECRET: 'b'.repeat(40) }, 'user-1')
    expect(await verifyAccessToken(cfg, token)).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const [h, , s] = (await signAccessToken(cfg, 'user-1')).split('.')
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', iss: 'lypcut', aud: 'lypcut-api', exp: 9999999999 }),
    ).toString('base64url')
    expect(await verifyAccessToken(cfg, `${h}.${forged}.${s}`)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('lypcut')
      .setAudience('lypcut-api')
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(key(cfg.AUTH_ACCESS_SECRET))
    expect(await verifyAccessToken(cfg, token)).toBeNull()
  })

  it('rejects the wrong issuer or audience', async () => {
    const make = (iss: string, aud: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuer(iss)
        .setAudience(aud)
        .setExpirationTime('5m')
        .sign(key(cfg.AUTH_ACCESS_SECRET))
    expect(await verifyAccessToken(cfg, await make('evil', 'lypcut-api'))).toBeNull()
    expect(await verifyAccessToken(cfg, await make('lypcut', 'other'))).toBeNull()
  })

  it('rejects alg=none and other algorithms', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u","iss":"lypcut","aud":"lypcut-api"}').toString('base64url')}.`
    expect(await verifyAccessToken(cfg, none)).toBeNull()
    const hs512 = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('u')
      .setIssuer('lypcut')
      .setAudience('lypcut-api')
      .setExpirationTime('5m')
      .sign(key(cfg.AUTH_ACCESS_SECRET))
    expect(await verifyAccessToken(cfg, hs512)).toBeNull()
  })

  it('rejects garbage', async () => {
    for (const junk of ['', 'abc', 'a.b.c', 'Bearer x'])
      expect(await verifyAccessToken(cfg, junk)).toBeNull()
  })
})

describe('refresh tokens', () => {
  it('are 256 bits of randomness, stored only as a hash', () => {
    const a = newRefreshToken()
    const b = newRefreshToken()
    expect(a.token).not.toBe(b.token)
    expect(Buffer.from(a.token, 'base64url').length).toBe(32)
    expect(a.hash).toBe(hashToken(a.token))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).not.toContain(a.token)
  })

  it('compare in constant time without length leaks causing errors', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
