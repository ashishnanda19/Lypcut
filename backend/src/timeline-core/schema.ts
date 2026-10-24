import { z } from 'zod'
import type { TimelineOp } from './types.js'

/**
 * The shape of an op, checked before the engine ever sees it. The engine (ops.ts) decides whether an op makes
 * sense for a timeline ("clips can't overlap"); this decides whether it is an op at all: every field present, the
 * right type, finite and in a sane range, and nothing extra. Unknown keys are refused rather than dropped, so
 * nothing can be smuggled into a stored timeline through an item or a settings patch. Limits on lengths, counts and
 * nesting keep a hostile or buggy client from making the server do unbounded work.
 */

/** About 277 hours in seconds: far beyond any real project, small enough that arithmetic stays exact. */
const MAX_TIME = 1_000_000
const MAX_BATCH = 500
const MAX_ITEMS_PER_OP = 5_000
const MAX_DEPTH = 4
const MAX_TOTAL_OPS = 2_000

const id = z.string().min(1).max(120)
const label = z.string().max(200)
const time = z.number().min(0).max(MAX_TIME)

const itemMeta = z.strictObject({
  text: z.string().max(2_000).optional(),
  dev: z.string().max(2_000).optional(),
  wordFrom: z.number().int().min(0).max(10_000_000).optional(),
  wordTo: z.number().int().min(0).max(10_000_000).optional(),
  effect: z.enum(['blur', 'zoom', 'shake']).optional(),
  amount: z.number().min(0).max(1_000).optional(),
  ai: z.boolean().optional(),
})

export const timelineItemSchema = z.strictObject({
  id,
  trackId: id,
  kind: z.enum(['video', 'broll', 'audio', 'caption', 'effect']),
  label,
  start: time,
  duration: z.number().min(0.001).max(MAX_TIME),
  srcIn: time,
  meta: itemMeta.optional(),
})

const crop = z.strictObject({
  x: z.number().min(-10).max(10),
  y: z.number().min(-10).max(10),
  scale: z.number().min(0).max(100),
})
const keyframe = z.strictObject({ ...crop.shape, t: time })
const marker = z.strictObject({ id, time, label })

/** A partial TimelineSettings, as `setSettings` and the settings half of `patch` carry. */
export const settingsPatchSchema = z.strictObject({
  captionStyleId: z.string().min(1).max(64).optional(),
  captionsOn: z.boolean().optional(),
  crop: crop.optional(),
  keyframes: z.array(keyframe).max(1_000).optional(),
  markers: z.array(marker).max(1_000).optional(),
  aspect: z.enum(['9:16', '1:1', '4:5', '16:9']).optional(),
  captionFont: z.string().max(100).optional(),
  captionAccent: z.string().max(32).optional(),
})

const items = z.array(timelineItemSchema).max(MAX_ITEMS_PER_OP)

const batch = z.strictObject({
  type: z.literal('batch'),
  get ops(): z.ZodArray<z.ZodType<TimelineOp>> {
    return z.array(timelineOpSchema).max(MAX_BATCH)
  },
  label: label.optional(),
})

export const timelineOpSchema: z.ZodType<TimelineOp> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('trim'),
    itemId: id,
    edge: z.enum(['start', 'end']),
    to: z.number().min(-MAX_TIME).max(MAX_TIME),
  }),
  z.strictObject({ type: z.literal('split'), itemId: id, at: time, newId: id.optional() }),
  z.strictObject({
    type: z.literal('move'),
    itemId: id,
    start: z.number().min(-MAX_TIME).max(MAX_TIME),
    trackId: id.optional(),
  }),
  z.strictObject({ type: z.literal('delete'), itemIds: z.array(id).max(MAX_ITEMS_PER_OP) }),
  z.strictObject({
    type: z.literal('rippleDelete'),
    from: z.number().min(-MAX_TIME).max(MAX_TIME),
    to: z.number().min(-MAX_TIME).max(MAX_TIME),
    trackIds: z.array(id).max(100).optional(),
  }),
  z.strictObject({
    type: z.literal('cutSource'),
    srcFrom: z.number().min(-MAX_TIME).max(MAX_TIME),
    srcTo: z.number().min(-MAX_TIME).max(MAX_TIME),
  }),
  z.strictObject({
    type: z.literal('restoreSource'),
    srcFrom: z.number().min(-MAX_TIME).max(MAX_TIME),
    srcTo: z.number().min(-MAX_TIME).max(MAX_TIME),
    captions: items.optional(),
  }),
  z.strictObject({ type: z.literal('addCaptions'), items, replace: z.boolean().optional() }),
  z.strictObject({ type: z.literal('addEffect'), item: timelineItemSchema }),
  z.strictObject({
    type: z.literal('setCrop'),
    crop,
    keyframes: z.array(keyframe).max(1_000).optional(),
  }),
  z.strictObject({ type: z.literal('setCaptionStyle'), styleId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('setSettings'), patch: settingsPatchSchema }),
  z.strictObject({ type: z.literal('addMarker'), marker }),
  z.strictObject({ type: z.literal('removeMarker'), id }),
  z.strictObject({
    type: z.literal('patch'),
    upsert: items,
    remove: z.array(id).max(MAX_ITEMS_PER_OP),
    settings: settingsPatchSchema.optional(),
  }),
  batch,
]) as unknown as z.ZodType<TimelineOp>

/** How deeply batches nest, and how many ops there are in all, counting those inside batches. */
export function measureOp(op: TimelineOp): { depth: number; count: number } {
  if (op.type !== 'batch') return { depth: 1, count: 1 }
  let depth = 0
  let count = 1
  for (const o of op.ops) {
    const m = measureOp(o)
    depth = Math.max(depth, m.depth)
    count += m.count
  }
  return { depth: depth + 1, count }
}

/**
 * How deeply JSON is nested, found without recursion. The schema below is recursive (batches contain ops), so a
 * payload nested thousands of levels deep would overflow the stack inside the validator itself. This runs first, with
 * an explicit stack, and stops as soon as the limit is passed.
 */
export function jsonDepthExceeds(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]]
  while (stack.length) {
    const [v, depth] = stack.pop()!
    if (v === null || typeof v !== 'object') continue
    if (depth > max) return true
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1])
  }
  return false
}

/** A legitimate request nests a few levels (batches are limited to 4); this is generous headroom, not a target. */
const MAX_JSON_DEPTH = 40

/** A list of ops (what a request carries): at least one, not unreasonably many, not deeply nested. */
const opsList = z
  .array(timelineOpSchema)
  .min(1, 'Send at least one change.')
  .max(200, 'Too many changes in one request.')
  .superRefine((ops, ctx) => {
    let total = 0
    for (const [i, op] of ops.entries()) {
      const m = measureOp(op)
      total += m.count
      if (m.depth > MAX_DEPTH) {
        ctx.addIssue({ code: 'custom', path: [i], message: 'Changes are nested too deeply.' })
      }
    }
    if (total > MAX_TOTAL_OPS) {
      ctx.addIssue({ code: 'custom', message: 'Too many changes in one request.' })
    }
  })

/** What a request body uses: the depth guard first, then the full schema. */
export const timelineOpsInput = z
  .unknown()
  .transform((value, ctx) => {
    if (jsonDepthExceeds(value, MAX_JSON_DEPTH)) {
      ctx.issues.push({ code: 'custom', input: value, message: 'Changes are nested too deeply.' })
      return z.NEVER
    }
    return value
  })
  .pipe(opsList)

export const timelineOpsSchema = opsList
