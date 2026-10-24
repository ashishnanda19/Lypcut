import { z } from 'zod'
import { timelineOpsInput } from '../../timeline-core/schema.js'
import type { Timeline, TimelineOp } from '../../timeline-core/types.js'

/** The front end calls these 'you' and 'ai' (its `Version.author`); the database stores 'user' and 'assistant'. */
export const authorSchema = z.enum(['you', 'ai'])

/** The editor's view of a timeline's history: where you are, and whether undo and redo have anywhere to go. */
export interface TimelineState {
  /** The version the timeline is at. A client sends this back as `baseVersion` with its next edit. */
  version: number
  /** The highest version number issued. Above `version` after an undo. */
  lastVersion: number
  canUndo: boolean
  canRedo: boolean
  timeline: Timeline
}

export const timelineStateSchema = z.object({
  version: z.number(),
  lastVersion: z.number(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  // Validated on the way in (the op schema, the engine's invariants), so not re-validated on the way out.
  timeline: z.custom<Timeline>(),
})

/** A history entry, without its snapshot: the History panel lists many of these. */
export const versionSchema = z.object({
  id: z.string(),
  n: z.number(),
  parentN: z.number().nullable(),
  author: authorSchema,
  label: z.string(),
  /** Milliseconds since the epoch, as the front end's `Version.at`. */
  at: z.number(),
  editId: z.string().optional(),
  /** The version the timeline is at now. */
  current: z.boolean(),
  /** On the path from the first version to the current one (the edits that led here). */
  onBranch: z.boolean(),
  /** Reachable with redo. */
  redoable: z.boolean(),
})
export type VersionDto = z.infer<typeof versionSchema>

export const versionDetailSchema = z.object({
  version: versionSchema,
  op: z.custom<TimelineOp>(),
  inverse: z.custom<TimelineOp>(),
  timeline: z.custom<Timeline>(),
})

const baseVersion = z.number().int().min(0)

export const applyOpsBody = z.object({
  /** The version the client based this edit on. A mismatch is a conflict. */
  baseVersion,
  ops: timelineOpsInput,
  /** What the History panel calls this change. */
  label: z.string().trim().min(1, 'Describe the change.').max(200),
  author: authorSchema.default('you'),
  /** The Edit card in the chat that produced this, if any. */
  editId: z.string().max(100).optional(),
})

export const baseVersionBody = z.object({ baseVersion })

export const restoreBody = z.object({ baseVersion, versionN: z.number().int().min(0) })

export const commitResponse = z.object({ version: versionSchema, state: timelineStateSchema })

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Return versions older than this number: pass the smallest `n` you already have to page back. */
  before: z.coerce.number().int().min(0).optional(),
})

export const historyResponse = z.object({
  current: z.number(),
  versions: z.array(versionSchema),
  hasMore: z.boolean(),
})

export const versionParam = z.object({ id: z.string(), n: z.coerce.number().int().min(0) })
