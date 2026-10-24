import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { langEnum, projectStatusEnum } from './enums.js'
import { pk, timestamps } from './_helpers.js'
import { users } from './users.js'

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    status: projectStatusEnum().notNull().default('uploading'),
    /** Measured by ffprobe after upload. Never taken from the client. */
    durationSec: doublePrecision(),
    sourceLanguage: langEnum().notNull().default('hinglish'),
    /** Seed for the front end's generated placeholder thumbnail. */
    thumbSeed: text().notNull(),
    hooksFound: integer(),
    /** The plan's limits when the project was created, so later plan changes do not rewrite history. */
    planLimits: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Last failure shown to the user, if the project failed. */
    error: text(),
    ...timestamps(),
  },
  (t) => [
    index('projects_owner_updated_idx').on(t.ownerId, t.updatedAt.desc()),
    index('projects_owner_status_idx').on(t.ownerId, t.status),
    check('projects_duration_nonneg', sql`${t.durationSec} is null or ${t.durationSec} >= 0`),
  ],
)
