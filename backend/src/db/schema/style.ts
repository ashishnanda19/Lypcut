import {
  bigint,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import {
  instagramAccountStatusEnum,
  instagramAccountTypeEnum,
  reelSourceEnum,
  reelStatusEnum,
  styleConfidenceEnum,
} from './enums.js'
import { createdAt, pk, timestamps } from './_helpers.js'
import { assets } from './media.js'
import { users } from './users.js'

/**
 * The creator's connected Instagram account. One per person. The access token is stored only as the vault's sealed
 * envelope (AES-256-GCM, see src/style/instagram/vault.ts), never in clear text, and is never returned by any route.
 */
export const instagramAccounts = pgTable(
  'instagram_accounts',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Instagram's id for the professional account. Meta's deletion callback names a person by it. */
    igUserId: text().notNull(),
    handle: text().notNull(),
    accountType: instagramAccountTypeEnum().notNull(),
    /** The sealed token: version, key id, nonce and ciphertext. */
    tokenEnvelope: text().notNull(),
    /** Which key sealed it, kept in its own column so a rotation can find what is left to re-seal. */
    keyId: text().notNull(),
    tokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    tokenRefreshedAt: timestamp({ withTimezone: true }),
    /** The scopes the person approved, for showing them what they agreed to. */
    scopes: jsonb().$type<string[]>().notNull().default([]),
    status: instagramAccountStatusEnum().notNull().default('active'),
    lastSyncAt: timestamp({ withTimezone: true }),
    /** A short code for why the last sync or refresh failed. Never a message from Meta, never text from the account. */
    lastError: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('instagram_accounts_user_uq').on(t.userId),
    index('instagram_accounts_ig_user_idx').on(t.igUserId),
    index('instagram_accounts_expiry_idx').on(t.status, t.tokenExpiresAt),
    index('instagram_accounts_key_idx').on(t.keyId),
  ],
)

/**
 * A Reel the profile is learned from, whichever way it arrived. For Instagram only ids, dates and numbers are kept: no
 * caption, no comments, no names of people who engaged, and no video file.
 */
export const reels = pgTable(
  'reels',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid().references(() => instagramAccounts.id, { onDelete: 'cascade' }),
    source: reelSourceEnum().notNull(),
    /** Instagram's media id. Null for an upload. */
    externalId: text(),
    /** The uploaded file, until analysis finishes and it is deleted. */
    assetId: uuid().references(() => assets.id, { onDelete: 'set null' }),
    thumbnailAssetId: uuid().references(() => assets.id, { onDelete: 'set null' }),
    /** What the Style page calls it: the uploaded file's name, or a dated label for an Instagram Reel. Never a caption. */
    label: text().notNull(),
    durationSec: doublePrecision(),
    postedAt: timestamp({ withTimezone: true }),
    status: reelStatusEnum().notNull().default('pending'),
    /** A short code when analysis failed. */
    failureCode: text(),
    /** SHA-256 of the file analysed: with the Reel id it is the key the analysis is cached under. */
    contentHash: text(),
    ...timestamps(),
  },
  (t) => [
    index('reels_user_posted_idx').on(t.userId, t.postedAt.desc()),
    index('reels_user_status_idx').on(t.userId, t.status),
    index('reels_account_idx').on(t.accountId),
    uniqueIndex('reels_user_source_external_uq')
      .on(t.userId, t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
    check(
      'reels_source_shape',
      sql`(${t.source} = 'instagram') = (${t.accountId} is not null and ${t.externalId} is not null)`,
    ),
    check('reels_duration_positive', sql`${t.durationSec} is null or ${t.durationSec} > 0`),
  ],
)

/**
 * The numbers for a Reel, one row per reading. Every metric is as it was returned, with when it was read, and a
 * metric Meta did not return, or the person did not type, is **null, never 0**.
 */
export const reelMetrics = pgTable(
  'reel_metrics',
  {
    id: pk(),
    reelId: uuid()
      .notNull()
      .references(() => reels.id, { onDelete: 'cascade' }),
    /** Who supplied these numbers: Instagram's API, or the person (typed or pasted). */
    origin: reelSourceEnum().notNull(),
    readAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    views: bigint({ mode: 'number' }),
    reach: bigint({ mode: 'number' }),
    likes: bigint({ mode: 'number' }),
    comments: bigint({ mode: 'number' }),
    saves: bigint({ mode: 'number' }),
    shares: bigint({ mode: 'number' }),
    /** Meta reports average watch time in seconds. */
    avgWatchSec: doublePrecision(),
    /** 0-100. Typed by the person, or worked out from seconds and the Reel's length. */
    avgWatchPct: doublePrecision(),
    /** 0-1: the share who left in the first three seconds, where Meta returns it. */
    skipRate: doublePrecision(),
    createdAt: createdAt(),
  },
  (t) => [
    index('reel_metrics_reel_read_idx').on(t.reelId, t.readAt.desc()),
    check(
      'reel_metrics_counts_nonneg',
      sql`coalesce(${t.views}, 0) >= 0 and coalesce(${t.reach}, 0) >= 0 and coalesce(${t.likes}, 0) >= 0
        and coalesce(${t.comments}, 0) >= 0 and coalesce(${t.saves}, 0) >= 0 and coalesce(${t.shares}, 0) >= 0`,
    ),
    check(
      'reel_metrics_ranges',
      sql`(${t.avgWatchSec} is null or ${t.avgWatchSec} >= 0)
        and (${t.avgWatchPct} is null or (${t.avgWatchPct} >= 0 and ${t.avgWatchPct} <= 100))
        and (${t.skipRate} is null or (${t.skipRate} >= 0 and ${t.skipRate} <= 1))`,
    ),
  ],
)

/** What was measured in a Reel. One row per Reel, replaced when the Reel is analysed again. */
export const reelAnalysis = pgTable(
  'reel_analysis',
  {
    id: pk(),
    reelId: uuid()
      .notNull()
      .references(() => reels.id, { onDelete: 'cascade' }),
    /** The file's hash and the algorithm's version: the same pair is never analysed twice. */
    contentHash: text().notNull(),
    algoVersion: text().notNull(),
    durationSec: doublePrecision().notNull(),
    /** Seconds to the first spoken sentence or the first strong visual change. Null if neither was found. */
    hookTimingSec: doublePrecision(),
    /** Scene cuts per ten seconds. */
    cutPace: doublePrecision().notNull(),
    /** Words per minute. Null for a Reel with no speech. */
    speechRateWpm: doublePrecision(),
    /** One of the editor's caption style ids, `custom` when none fits, null when the Reel has no captions. */
    captionStyleId: text(),
    /** How the caption style was decided: image rules, or the model's label. */
    captionStyleSource: text(),
    /** Font families the editor has (a closed list), nearest first. */
    fonts: jsonb().$type<string[]>().notNull().default([]),
    /** Dominant caption colours, as #rrggbb. */
    colors: jsonb().$type<string[]>().notNull().default([]),
    /** 0-100 against this creator's other Reels. Null when the Reel has no numbers. Recomputed with each profile. */
    engagementScore: doublePrecision(),
    analysedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reel_analysis_reel_uq').on(t.reelId),
    index('reel_analysis_hash_idx').on(t.contentHash),
    check(
      'reel_analysis_ranges',
      sql`${t.durationSec} > 0 and ${t.cutPace} >= 0
        and (${t.hookTimingSec} is null or ${t.hookTimingSec} >= 0)
        and (${t.engagementScore} is null or (${t.engagementScore} >= 0 and ${t.engagementScore} <= 100))`,
    ),
  ],
)

/** The derived profile: numbers and style ids only. Nothing in it is anyone's content. */
export const styleProfiles = pgTable(
  'style_profiles',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profile: jsonb().$type<Record<string, unknown>>().notNull(),
    confidence: styleConfidenceEnum().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('style_profiles_user_uq').on(t.userId)],
)

/**
 * A pending Instagram sign-in. `state` goes to Instagram and comes back on the callback; only its hash is stored,
 * it is tied to the person who started it, works once, and lasts ten minutes.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stateHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('oauth_states_hash_uq').on(t.stateHash),
    index('oauth_states_expires_idx').on(t.expiresAt),
    index('oauth_states_user_idx').on(t.userId),
  ],
)

export type ReelRow = typeof reels.$inferSelect
export type InstagramAccountRow = typeof instagramAccounts.$inferSelect
