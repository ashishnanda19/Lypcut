import { and, eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { instagramAccounts, reelMetrics, reels } from '../../db/schema/index.js'
import type { Log } from '../../lib/log.js'
import { InstagramError, type IgMedia, type InstagramClient } from '../instagram/client.js'
import { StyleAnalysis } from '../analysis/service.js'
import type { TranscriptionProvider } from '../../transcription/types.js'

const DAY = 86_400_000
/** A Reel read this recently is not read again by a second sync that starts straight after. */
const FRESH_MS = 10 * 60_000
/** Instagram will refresh a token that is at least a day old and not yet expired. */
const MIN_AGE_FOR_REFRESH_MS = DAY

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface SyncResult {
  /** Reels listed by Instagram. */
  listed: number
  /** Readings of numbers stored. */
  read: number
  /** The token stopped working: the account now needs to be connected again. */
  reauthRequired?: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** What the Style page calls a Reel: its date. Never its caption. */
const label = (d: Date) =>
  `Reel · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`

/**
 * Reads an Instagram account's recent Reels and their numbers, and keeps the sealed token alive. Both are safe to run twice:
 * a Reel is stored once however many syncs see it, and a reading is only added if the last one is not seconds old.
 *
 * Only ids, dates and numbers are stored. No caption, no comment, no one's name, and no video: this code has no way to ask for any.
 */
export class InstagramSync {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
    private readonly client: InstagramClient,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
  ) {}

  private get db() {
    return this.deps.database.db
  }
  private get sleep() {
    return this.opts.sleep ?? sleepFor
  }
  private get now() {
    return (this.opts.now ?? (() => new Date()))()
  }

  /** Runs a call to Instagram, waiting and trying again when it says to slow down or is briefly unavailable. */
  private async careful<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        if (!(e instanceof InstagramError) || attempt >= 4) throw e
        if (e.kind === 'rate_limited')
          await this.sleep(Math.min(e.retryAfterSec ?? 60, 300) * 1000 * (1 + Math.random() * 0.2))
        else if (e.kind === 'unavailable')
          await this.sleep(1000 * 2 ** (attempt - 1) * (1 + Math.random() * 0.2))
        else throw e
      }
    }
  }

  /** The token has stopped working. Stop reading, and let the Style page say Reconnect. */
  private async needsReconnect(accountId: string) {
    await this.db
      .update(instagramAccounts)
      .set({ status: 'reauth_required', lastError: 'token_invalid' })
      .where(eq(instagramAccounts.id, accountId))
  }

  async sync(
    userId: string,
    provider: TranscriptionProvider,
    onProgress?: (done: number, total: number) => void,
  ): Promise<SyncResult> {
    const [account] = await this.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.userId, userId))
    if (!account || account.status !== 'active')
      return { listed: 0, read: 0, reauthRequired: account?.status === 'reauth_required' }
    const token = this.deps.vault.open(account.tokenEnvelope, userId)
    const max = this.deps.config.STYLE_MAX_REELS
    const result: SyncResult = { listed: 0, read: 0 }

    try {
      const media = await this.careful(() => this.client.listMedia(token, max))
      result.listed = media.length
      const known = await this.db
        .select()
        .from(reels)
        .where(and(eq(reels.userId, userId), eq(reels.accountId, account.id)))
      const byExternal = new Map(known.map((r) => [r.externalId, r]))
      const readRecently = new Set(
        (
          await this.db
            .select({ id: reelMetrics.reelId })
            .from(reelMetrics)
            .where(
              and(
                inArray(
                  reelMetrics.reelId,
                  known.map((r) => r.id).concat('00000000-0000-0000-0000-000000000000'),
                ),
                gt(reelMetrics.readAt, new Date(this.now.getTime() - FRESH_MS)),
              ),
            )
        ).map((r) => r.id),
      )

      const kept: string[] = []
      let done = 0
      for (const m of media) {
        const have = byExternal.get(m.id)
        if (have && readRecently.has(have.id)) {
          kept.push(m.id)
        } else {
          if (done > 0 || result.read > 0)
            await this.sleep(this.deps.config.STYLE_IG_CALL_INTERVAL_MS)
          // Slow down on our own when Instagram says most of the allowance is used.
          if ((this.client.usagePercent ?? 0) >= 80) await this.sleep(5000)
          const numbers = await this.careful(() => this.client.insights(token, m.id))
          // No Reels numbers for it: not a Reel.
          if (numbers) {
            kept.push(m.id)
            const reel = have ?? (await this.addReel(userId, account.id, m))
            await this.db
              .insert(reelMetrics)
              .values({ reelId: reel.id, origin: 'instagram', readAt: this.now, ...numbers })
            result.read++
          }
        }
        onProgress?.(++done, media.length)
      }

      // The Reels that are not in the newest N, or that are gone from Instagram, are not kept.
      await this.db
        .delete(reels)
        .where(
          and(
            eq(reels.userId, userId),
            eq(reels.accountId, account.id),
            kept.length ? notInArray(reels.externalId, kept) : sql`true`,
          ),
        )

      await this.db
        .update(instagramAccounts)
        .set({ lastSyncAt: this.now, lastError: null })
        .where(eq(instagramAccounts.id, account.id))
    } catch (e) {
      if (e instanceof InstagramError && e.kind === 'auth') {
        await this.needsReconnect(account.id)
        this.log.warn({ userId }, 'instagram token no longer works; reconnect needed')
        return { ...result, reauthRequired: true }
      }
      if (e instanceof InstagramError) {
        await this.db
          .update(instagramAccounts)
          .set({ lastError: e.kind })
          .where(eq(instagramAccounts.id, account.id))
      }
      throw e
    }

    await new StyleAnalysis(this.deps, this.log, provider).rebuildProfile(userId)
    return result
  }

  private async addReel(userId: string, accountId: string, m: IgMedia) {
    const [row] = await this.db
      .insert(reels)
      .values({
        userId,
        accountId,
        source: 'instagram',
        externalId: m.id,
        label: label(m.postedAt),
        postedAt: m.postedAt,
        // Known by its numbers: there is no file to measure, so it is finished as soon as it exists.
        status: 'analysed',
      })
      .returning()
    return row!
  }

  /**
   * Another 60 days for the token. Done well before it runs out, and only for a token Instagram will still refresh: more than a
   * day old and not expired. If it has already expired, or Instagram refuses, the person has to connect again.
   */
  async refreshToken(userId: string): Promise<{ refreshed: boolean; reauthRequired?: boolean }> {
    const [account] = await this.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.userId, userId))
    if (!account || account.status !== 'active')
      return { refreshed: false, reauthRequired: account?.status === 'reauth_required' }
    const now = this.now
    if (account.tokenExpiresAt <= now) {
      await this.needsReconnect(account.id)
      return { refreshed: false, reauthRequired: true }
    }
    const since = account.tokenRefreshedAt ?? account.createdAt
    if (now.getTime() - since.getTime() < MIN_AGE_FOR_REFRESH_MS) return { refreshed: false }
    try {
      const fresh = await this.careful(() =>
        this.client.refresh(this.deps.vault.open(account.tokenEnvelope, userId)),
      )
      const sealed = this.deps.vault.seal(fresh.accessToken, userId)
      await this.db
        .update(instagramAccounts)
        .set({
          tokenEnvelope: sealed.envelope,
          keyId: sealed.keyId,
          tokenExpiresAt: new Date(now.getTime() + fresh.expiresInSec * 1000),
          tokenRefreshedAt: now,
          lastError: null,
        })
        .where(eq(instagramAccounts.id, account.id))
      return { refreshed: true }
    } catch (e) {
      if (e instanceof InstagramError && (e.kind === 'auth' || e.kind === 'bad_request')) {
        await this.needsReconnect(account.id)
        this.log.warn({ userId }, 'instagram refused to refresh the token; reconnect needed')
        return { refreshed: false, reauthRequired: true }
      }
      if (e instanceof InstagramError) {
        await this.db
          .update(instagramAccounts)
          .set({ lastError: e.kind })
          .where(eq(instagramAccounts.id, account.id))
      }
      throw e
    }
  }
}
