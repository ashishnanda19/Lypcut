import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { contentTypeEnum, langEnum, planEnum } from './enums.js'
import { createdAt, pk, timestamps } from './_helpers.js'

export const users = pgTable(
  'users',
  {
    id: pk(),
    /** Stored lower-cased and trimmed by the service, so the unique index is case-insensitive. */
    email: text().notNull(),
    name: text().notNull(),
    /** argon2id hash. Null for a future social-login-only account. */
    passwordHash: text(),
    plan: planEnum().notNull().default('free'),
    lastLoginAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
)

/** One row per refresh token. Rotating a token revokes the old row and adds a new one in the same family. */
export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: text().notNull(),
    /** Every token descended from one login shares a family, so reuse of a rotated token revokes all of it. */
    familyId: uuid().notNull(),
    userAgent: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

export const userPreferences = pgTable('user_preferences', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  language: langEnum().notNull().default('hinglish'),
  contentType: contentTypeEnum(),
  /** Set when onboarding finishes. */
  onboardedAt: timestamp({ withTimezone: true }),
  ...timestamps(),
})
