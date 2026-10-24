import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { jobStatusEnum, jobTypeEnum, stageStatusEnum, usageKindEnum } from './enums.js'
import { createdAt, pk, timestamps } from './_helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export interface JobFound {
  language?: string
  speakers?: number
  scenes?: number
  hooks?: number
}

export const jobs = pgTable(
  'jobs',
  {
    id: pk(),
    /**
     * Who the job belongs to, for ownership checks. SET NULL (not CASCADE) so the cleanup job that
     * deletes an account's files can outlive the account.
     */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Null for jobs that are not about a live project (cleanup after a project is deleted). */
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    type: jobTypeEnum().notNull(),
    status: jobStatusEnum().notNull().default('queued'),
    /** 0-100, as the front end shows it. */
    progress: integer().notNull().default(0),
    /** Index of the current user-facing step (0-4), as the front end's Processing screen shows it. */
    step: integer(),
    /** Human-readable stage name shown while waiting, for example "Transcribing". */
    detail: text(),
    /** The internal pipeline stage key currently running, for example "transcribe". */
    stage: text(),
    /** Live findings shown while waiting. */
    found: jsonb().$type<JobFound>().notNull().default({}),
    error: text(),
    errorCode: text(),
    attempts: integer().notNull().default(0),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('jobs_project_type_idx').on(t.projectId, t.type, t.createdAt.desc()),
    index('jobs_user_status_idx').on(t.userId, t.status),
    index('jobs_status_idx').on(t.status),
    check('jobs_progress', sql`${t.progress} between 0 and 100`),
  ],
)

/** One row per pipeline stage per job: the checkpoints that let a failed job resume where it stopped. */
export const jobStages = pgTable(
  'job_stages',
  {
    id: pk(),
    jobId: uuid()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    stage: text().notNull(),
    status: stageStatusEnum().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    error: text(),
    /** Anything a later stage needs from this one, for example the storage key of the extracted audio. */
    output: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex('job_stages_job_stage_uq').on(t.jobId, t.stage)],
)

/** Append-only usage, summed to enforce plan limits (uploads this month, video minutes). */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: usageKindEnum().notNull(),
    amount: doublePrecision().notNull(),
    projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('usage_user_kind_created_idx').on(t.userId, t.kind, t.createdAt)],
)
