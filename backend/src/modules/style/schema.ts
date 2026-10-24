import { z } from 'zod'

/**
 * The shapes the front end already reads (`StyleProfile` and `ReelMetric` in frontend/src/types/index.ts), plus what the server
 * adds. Where a number can be unknown it is null here, never 0: the front end shows "unknown" for null.
 */

export const styleProfileSchema = z.object({
  connected: z.boolean(),
  source: z.enum(['instagram', 'upload']).nullable(),
  handle: z.string().optional(),
  reelsAnalysed: z.number(),
  hookTimingSec: z.number(),
  /** Cuts per 10 seconds. */
  cutPace: z.number(),
  captionStyles: z.array(z.object({ id: z.string(), share: z.number() })),
  /** Always empty: music is not learned in this version. The field stays so the front end's type is unchanged. */
  music: z.array(z.object({ label: z.string(), share: z.number() })),
  hookRetention: z.array(z.number()),
  fonts: z.array(z.string()),
  colors: z.array(z.string()),
  /** Added by the server. */
  confidence: z.enum(['low', 'medium', 'high']),
  updatedAt: z.string().nullable(),
  /** One sentence about the style, in the person's language. Absent when none could be written. */
  summary: z.string().optional(),
})
export type StyleProfileDto = z.infer<typeof styleProfileSchema>

export const reelMetricSchema = z.object({
  id: z.string(),
  title: z.string(),
  thumbSeed: z.string(),
  /** A short-lived link to the Reel's picture. Absent while there is none (the page shows a placeholder from `thumbSeed`). */
  thumbUrl: z.string().optional(),
  views: z.number().nullable(),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
  saves: z.number().nullable(),
  shares: z.number().nullable(),
  avgWatchPct: z.number().nullable(),
  durationSec: z.number(),
  postedAt: z.string(),
  /** 0-100 against the person's other Reels; null when the Reel has no numbers to score. */
  engagement: z.number().nullable(),
  source: z.enum(['instagram', 'upload']),
})
export type ReelMetricDto = z.infer<typeof reelMetricSchema>

export const styleStateSchema = z.enum([
  'idle',
  'syncing',
  'analysing',
  'ready',
  'reauth_required',
  'failed',
])

export const styleStatusSchema = z.object({
  state: styleStateSchema,
  /** 0-100 while analysing or syncing. */
  progress: z.number(),
  reels: z.object({
    total: z.number(),
    analysed: z.number(),
    analysing: z.number(),
    /** Uploaded, not yet submitted. */
    pending: z.number(),
    failed: z.number(),
  }),
  /** Reels that could not be analysed, with a reason the person can act on. */
  failed: z.array(
    z.object({ id: z.string(), label: z.string(), code: z.string(), message: z.string() }),
  ),
  updatedAt: z.string().nullable(),
})
export type StyleStatusDto = z.infer<typeof styleStatusSchema>

const count = z.number().int().min(0).max(10_000_000_000)
export const reelNumbersSchema = z
  .object({
    /** Which Reel: the id returned when its upload finished, or its file name. One of them is needed. */
    reelId: z.uuid().optional(),
    fileName: z.string().trim().min(1).max(255).optional(),
    views: count.optional(),
    likes: count.optional(),
    comments: count.optional(),
    saves: count.optional(),
    shares: count.optional(),
    /** The share of the Reel people watch on average, 0-100. */
    avgWatchPct: z.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((m) => m.reelId !== undefined || m.fileName !== undefined, {
    message: 'Say which Reel these numbers are for, by reelId or fileName.',
    path: ['reelId'],
  })

export const submitUploadBody = z.object({
  /** How many uploaded Reels the person means to learn from. They must all have finished uploading. */
  count: z.number().int().min(1).max(10),
  /** Their numbers, if they typed or pasted them. A Reel without numbers is still learned from, for its style. */
  metrics: z.array(reelNumbersSchema).max(10).optional(),
})
