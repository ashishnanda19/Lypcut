import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { instagramAccounts, jobs, oauthStates } from '../../db/schema/index.js'
import { err } from '../../lib/errors.js'
import type { Log } from '../../lib/log.js'
import { enqueueJob } from '../../queue/enqueue.js'
import { InstagramError, READ_SCOPES, type InstagramClient } from './client.js'

/** How long a sign-in has to be finished, and how many a person can have open at once (another tab, a retry). */
export const STATE_TTL_MS = 10 * 60_000
const MAX_OPEN_STATES = 5

const hashOf = (state: string) => createHash('sha256').update(state).digest('hex')

/** What the connect screen says, in plain words. Sent with the address so the page can show it before the person leaves. */
export const CONSENT: { reads: string[]; uses: string; never: string[]; disconnect: string } = {
  reads: [
    'Your Reels: when they were posted, and how long ago.',
    'Their numbers: views, likes, comments, saves, shares and watch time.',
    'Your handle, to show which account is connected.',
  ],
  uses: 'Lypcut works out which of your Reels did best and learns your style from them: how soon you start, how often you cut, your captions.',
  never: [
    'Post, comment, message or change anything on your Instagram.',
    'Read your followers, your comments or your messages, or download your videos.',
    'Share your data with anyone.',
  ],
  disconnect:
    'You can disconnect at any time on the Style page. That removes your connection, your Reels and your style within 24 hours.',
}

export type ConnectResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'denied'
        | 'invalid_state'
        | 'permission_denied'
        | 'not_professional_account'
        | 'exchange_failed'
        | 'unavailable'
    }

/**
 * Connecting Instagram. The person is sent to Instagram with a `state` that is random, belongs to them, works once and lasts ten
 * minutes; only its hash is kept. When Instagram sends them back, nothing is asked of Instagram until the state has been
 * checked and spent.
 */
export class InstagramOAuth {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
    private readonly client: InstagramClient,
  ) {}

  private get db() {
    return this.deps.database.db
  }

  /** The address to send the person to, and what to tell them first. */
  async start(
    userId: string,
  ): Promise<{ authUrl: string; consent: typeof CONSENT; scopes: string[] }> {
    const now = new Date()
    await this.db.delete(oauthStates).where(lt(oauthStates.expiresAt, now))
    // Keep a few open at once and no more: the oldest unused go first.
    await this.db.execute(sql`
      delete from oauth_states where id in (
        select id from oauth_states where user_id = ${userId} and used_at is null
        order by created_at desc offset ${MAX_OPEN_STATES - 1}
      )`)
    const state = randomBytes(32).toString('base64url')
    await this.db.insert(oauthStates).values({
      userId,
      stateHash: hashOf(state),
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    })
    return { authUrl: this.client.authorizeUrl(state), consent: CONSENT, scopes: [...READ_SCOPES] }
  }

  /**
   * Finishes a sign-in. `sessionUserId` is who the browser is logged in as, if it sent a session: when that is someone other than
   * whoever started the sign-in, it is refused. Returns what happened, for the page to explain; nothing here returns a token.
   */
  async callback(
    q: { code?: string; state?: string; error?: string },
    sessionUserId: string | null,
  ): Promise<ConnectResult> {
    if (!q.state) return { ok: false, reason: 'invalid_state' }
    const now = new Date()
    // Spend the state first, in one statement, so two callbacks cannot both use it.
    const [row] = await this.db
      .update(oauthStates)
      .set({ usedAt: now })
      .where(
        and(
          eq(oauthStates.stateHash, hashOf(q.state)),
          isNull(oauthStates.usedAt),
          gt(oauthStates.expiresAt, now),
        ),
      )
      .returning()
    if (!row) return { ok: false, reason: 'invalid_state' }
    if (sessionUserId && sessionUserId !== row.userId) {
      this.log.warn({ userId: row.userId }, 'an Instagram sign-in came back to a different login')
      return { ok: false, reason: 'invalid_state' }
    }
    // The person said no on Instagram's screen.
    if (q.error || !q.code) return { ok: false, reason: 'denied' }

    const userId = row.userId
    try {
      const short = await this.client.exchangeCode(q.code)
      // If Instagram says which permissions were approved, both reads are needed: without the numbers there is nothing to learn from.
      if (short.scopes && !READ_SCOPES.every((s) => short.scopes!.includes(s)))
        return { ok: false, reason: 'permission_denied' }
      const long = await this.client.toLongLived(short.accessToken)
      const profile = await this.client.profile(long.accessToken)
      // A personal account cannot be read through this API. Nothing is stored for it.
      if (profile.accountType !== 'business' && profile.accountType !== 'creator')
        return { ok: false, reason: 'not_professional_account' }

      const sealed = this.deps.vault.seal(long.accessToken, userId)
      const expiresAt = new Date(now.getTime() + long.expiresInSec * 1000)
      const [existing] = await this.db
        .select()
        .from(instagramAccounts)
        .where(eq(instagramAccounts.userId, userId))
      // Connecting a different Instagram account starts fresh: the old account's Reels are not this one's.
      if (existing && existing.igUserId !== profile.userId)
        await this.db.delete(instagramAccounts).where(eq(instagramAccounts.id, existing.id))
      const values = {
        userId,
        igUserId: profile.userId,
        handle: profile.handle,
        accountType: profile.accountType,
        tokenEnvelope: sealed.envelope,
        keyId: sealed.keyId,
        tokenExpiresAt: expiresAt,
        tokenRefreshedAt: null,
        scopes: short.scopes ?? [...READ_SCOPES],
        status: 'active' as const,
        lastError: null,
      }
      await this.db
        .insert(instagramAccounts)
        .values(values)
        .onConflictDoUpdate({
          target: instagramAccounts.userId,
          set: { ...values, updatedAt: now },
        })

      const [job] = await this.db
        .insert(jobs)
        .values({ userId, type: 'style_sync', detail: 'Reading your Reels' })
        .returning()
      await enqueueJob(this.deps.queues, job!).catch((e) =>
        this.log.error(
          { err: e, jobId: job!.id },
          'could not enqueue the first sync; the sweep will retry',
        ),
      )
      this.log.info({ userId, accountType: profile.accountType }, 'instagram connected')
      return { ok: true }
    } catch (e) {
      if (e instanceof InstagramError) {
        this.log.warn({ userId, kind: e.kind }, 'instagram sign-in could not be finished')
        return {
          ok: false,
          reason:
            e.kind === 'unavailable' || e.kind === 'rate_limited'
              ? 'unavailable'
              : 'exchange_failed',
        }
      }
      throw e
    }
  }

  /** The Style page's address, with what happened. Always the configured front end: never anything from the request. */
  redirectFor(result: ConnectResult): string {
    const base = (
      this.deps.config.APP_URL ??
      this.deps.config.CORS_ORIGINS[0] ??
      'http://localhost:5173'
    ).replace(/\/$/, '')
    return result.ok
      ? `${base}/app/style?connected=1`
      : `${base}/app/style?connected=0&reason=${result.reason}`
  }
}

export const requireInstagram = (deps: AppDeps): InstagramClient => {
  if (!deps.instagram)
    throw err.notImplemented(
      'Instagram is not set up on this server. You can upload your Reels instead.',
    )
  return deps.instagram
}
