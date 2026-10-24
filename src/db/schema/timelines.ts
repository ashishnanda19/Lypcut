import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { versionAuthorEnum } from './enums.js'
import { createdAt, pk, timestamps } from './_helpers.js'
import { projects } from './projects.js'

/** The editable multi-track timeline. One per project. */
export const timelines = pgTable(
  'timelines',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The version being shown. Undo and redo move this cursor; they never delete versions. */
    currentVersion: integer().notNull().default(0),
    /** Highest version number handed out, so a new edit after an undo still gets a fresh number. */
    lastVersion: integer().notNull().default(0),
    /** Version numbers undo has stepped back from, newest last. Cleared by any new edit. */
    redoStack: jsonb().$type<number[]>().notNull().default([]),
    sourceDuration: doublePrecision().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('timelines_project_uq').on(t.projectId),
    check('timelines_versions', sql`${t.currentVersion} <= ${t.lastVersion}`),
  ],
)

/** A full snapshot of the timeline after each change, plus the op that produced it and its inverse. */
export const timelineVersions = pgTable(
  'timeline_versions',
  {
    id: pk(),
    timelineId: uuid()
      .notNull()
      .references(() => timelines.id, { onDelete: 'cascade' }),
    n: integer().notNull(),
    /** The version this edit was made on top of. Null for the first one. */
    parentN: integer(),
    createdBy: versionAuthorEnum().notNull(),
    label: text().notNull(),
    /** The Edit card in the chat that produced this version, if any. */
    editId: text(),
    snapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    op: jsonb().$type<Record<string, unknown>>().notNull(),
    inverse: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('timeline_versions_n_uq').on(t.timelineId, t.n),
    index('timeline_versions_created_idx').on(t.timelineId, t.createdAt.desc()),
  ],
)

/** The reversible operation log: each op as applied, with the inverse that undoes it. */
export const timelineOps = pgTable(
  'timeline_ops',
  {
    id: pk(),
    timelineId: uuid()
      .notNull()
      .references(() => timelines.id, { onDelete: 'cascade' }),
    /** The version this op helped produce. */
    versionN: integer().notNull(),
    /** Position within that version's batch. */
    seq: integer().notNull(),
    actor: versionAuthorEnum().notNull(),
    op: jsonb().$type<Record<string, unknown>>().notNull(),
    inverse: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('timeline_ops_version_seq_uq').on(t.timelineId, t.versionN, t.seq)],
)
