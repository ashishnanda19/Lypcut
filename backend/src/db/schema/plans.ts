import { index, integer, jsonb, pgTable, real, text, uuid } from 'drizzle-orm/pg-core'
import { planStatusEnum } from './enums.js'
import { pk, timestamps } from './_helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export interface PlanStripSegment {
  kind: 'keep' | 'cut' | 'add'
  weight: number
}
export interface PlanSummaryChip {
  label: string
  value: string
  tone?: 'neutral' | 'saffron' | 'teal' | 'coral'
}

/**
 * What the assistant proposed: an op, with what the Edit card shows. Saved the moment the op passes the validator's
 * dry run, before anyone has applied it. Applying it makes an ordinary timeline version (author: the assistant, editId:
 * this plan's id); undoing that version marks the plan undone.
 */
export const editPlans = pgTable(
  'edit_plans',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The timeline version the op was checked against. */
    baseVersion: integer().notNull(),
    op: jsonb().$type<Record<string, unknown>>().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    strip: jsonb().$type<PlanStripSegment[]>().notNull(),
    summary: jsonb().$type<PlanSummaryChip[]>().notNull(),
    /** Timeline seconds the player should jump to when previewing. */
    focus: real(),
    status: planStatusEnum().notNull().default('proposed'),
    /** The version applying it created, and the version that took it back (if one did). */
    appliedVersion: integer(),
    undoneByVersion: integer(),
    ...timestamps(),
  },
  (t) => [index('edit_plans_project_created_idx').on(t.projectId, t.createdAt)],
)
