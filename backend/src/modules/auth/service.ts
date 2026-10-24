import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { sessions, userPreferences, users } from '../../db/schema/index.js'
import { isUniqueViolation } from '../../db/errors.js'
import { AppError, err } from '../../lib/errors.js'
import { uuidv7 } from '../../lib/ids.js'
import { hashPassword } from '../../lib/password.js'
import { loadUserDto, nameFromEmail } from '../account/service.js'
import type { UserDto } from '../account/schema.js'
import type { IssuedTokens } from './cookies.js'
import { PasswordProvider, type IdentityProvider, type PasswordInput } from './providers.js'
import { hashToken, newRefreshToken, safeEqual, signAccessToken } from './tokens.js'

type UserRow = typeof users.$inferSelect

export interface AuthResult {
  user: UserDto
  tokens: IssuedTokens
}

export class AuthService {
  private readonly passwords: IdentityProvider<PasswordInput>

  constructor(private readonly deps: AppDeps) {
    this.passwords = new PasswordProvider(deps.database.db)
  }

  private get db() {
    return this.deps.database.db
  }
  private get cfg() {
    return this.deps.config
  }

  async signup(
    input: { name?: string; email: string; password: string },
    userAgent?: string,
  ): Promise<AuthResult> {
    const passwordHash = await hashPassword(input.password)
    let user: UserRow
    try {
      user = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({
            email: input.email,
            name: input.name?.trim() || nameFromEmail(input.email),
            passwordHash,
          })
          .returning()
        await tx.insert(userPreferences).values({ userId: created!.id })
        return created!
      })
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw err.conflict(
          'EMAIL_TAKEN',
          'An account with this email already exists. Try logging in.',
          {
            field: 'email',
          },
        )
      }
      throw e
    }
    return this.finish(user, userAgent)
  }

  async login(input: PasswordInput, userAgent?: string): Promise<AuthResult> {
    const lockKey = `auth:fail:${createHash('sha256').update(input.email).digest('hex').slice(0, 32)}`
    await this.assertNotLocked(lockKey)

    let user: UserRow
    try {
      user = await this.passwords.authenticate(input)
    } catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_CREDENTIALS')
        await this.recordFailure(lockKey)
      throw e
    }
    await this.deps.redis.del(lockKey)
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
    return this.finish(user, userAgent)
  }

  /**
   * Swaps a refresh token for a new pair. Each refresh token works once: using a retired one means
   * it may have been stolen, so the whole login (token family) is revoked. A retired token reused
   * within a few seconds is almost certainly two tabs racing, so that case just fails without revoking.
   */
  async refresh(token: string | undefined, userAgent?: string): Promise<AuthResult> {
    if (!token) throw err.unauthenticated()
    const hash = hashToken(token)
    const [session] = await this.db.select().from(sessions).where(eq(sessions.tokenHash, hash))
    if (!session || !safeEqual(session.tokenHash, hash)) throw err.unauthenticated()

    const now = new Date()
    if (session.revokedAt) {
      const sinceRotation = now.getTime() - session.revokedAt.getTime()
      if (sinceRotation > this.cfg.REFRESH_REUSE_GRACE_SEC * 1000)
        await this.revokeFamily(session.familyId)
      throw err.unauthenticated('Your session ended. Please log in again.')
    }
    if (session.expiresAt <= now)
      throw err.unauthenticated('Your session expired. Please log in again.')

    // Retire the old token. If another request retired it first, this updates nothing: that is the race.
    const retired = await this.db
      .update(sessions)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
    if (!retired.length) throw err.unauthenticated('Your session was just refreshed. Try again.')

    const [user] = await this.db.select().from(users).where(eq(users.id, session.userId))
    if (!user) throw err.unauthenticated()
    return this.finish(user, userAgent, session.familyId)
  }

  /** Ends this login on this device. Always succeeds, even for an unknown or expired token. */
  async logout(token: string | undefined): Promise<void> {
    if (!token) return
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
    if (session) await this.revokeFamily(session.familyId)
  }

  private async finish(
    user: UserRow,
    userAgent?: string,
    familyId = uuidv7(),
  ): Promise<AuthResult> {
    const dto = await loadUserDto(this.db, user.id)
    if (!dto) throw err.unauthenticated()
    return { user: dto, tokens: await this.startSession(user.id, familyId, userAgent) }
  }

  private async startSession(
    userId: string,
    familyId: string,
    userAgent?: string,
  ): Promise<IssuedTokens> {
    const refresh = newRefreshToken()
    await this.db.insert(sessions).values({
      userId,
      tokenHash: refresh.hash,
      familyId,
      userAgent: userAgent?.slice(0, 200),
      expiresAt: new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL_SEC * 1000),
    })
    return {
      accessToken: await signAccessToken(this.cfg, userId),
      refreshToken: refresh.token,
      expiresIn: this.cfg.ACCESS_TOKEN_TTL_SEC,
    }
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
  }

  /* ----------------------- failed-login lockout ----------------------- */

  private async assertNotLocked(key: string): Promise<void> {
    const failures = Number((await this.deps.redis.get(key)) ?? 0)
    if (failures >= this.cfg.LOGIN_MAX_FAILURES) {
      const ttl = await this.deps.redis.ttl(key)
      throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.', {
        retryAfterSec: Math.max(ttl, 1),
      })
    }
  }

  private async recordFailure(key: string): Promise<void> {
    const n = await this.deps.redis.incr(key)
    if (n === 1) await this.deps.redis.expire(key, this.cfg.LOGIN_LOCK_SEC)
  }
}
