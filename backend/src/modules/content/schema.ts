import { z } from 'zod'
import { langSchema } from '../account/schema.js'

/** The front end's transcript types (src/types/index.ts), on the wire. */

export const speakerSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(['saffron', 'teal']),
})

export const wordSchema = z.object({
  /** Roman (Hinglish) spelling. English words keep their English spelling. */
  text: z.string(),
  /** Devanagari spelling. Equals `text` for a word we have no Devanagari spelling for. */
  dev: z.string(),
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
  language: z.enum(['hi', 'en']),
  filler: z.literal(true).optional(),
})

export const sentenceSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  /** First word (inclusive) and one past the last (exclusive). Indices are into the whole transcript, even in a time-range response. */
  from: z.number(),
  to: z.number(),
  start: z.number(),
  end: z.number(),
})

export const transcriptSchema = z.object({
  language: langSchema,
  speakers: z.array(speakerSchema),
  words: z.array(wordSchema),
  sentences: z.array(sentenceSchema),
  /** Present only when a time range was asked for: where `words[0]` sits in the whole transcript. */
  range: z.object({ from: z.number(), to: z.number(), wordOffset: z.number() }).optional(),
})

export const transcriptQuery = z
  .object({
    /** Return only words that overlap [from, to] seconds of the source. Sentence indices stay global. */
    from: z.coerce.number().min(0).optional(),
    to: z.coerce.number().min(0).optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Give both from and to, or neither.',
    path: ['from'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.to > q.from, {
    message: 'to must be after from.',
    path: ['to'],
  })

export const sceneSchema = z.object({
  id: z.string(),
  label: z.string(),
  start: z.number(),
  end: z.number(),
  /** A short-lived link to the scene's thumbnail (an addition to the front end's Scene). */
  thumbUrl: z.string().optional(),
})

export const highlightSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
  hookScore: z.number(),
  reason: z.string(),
  thumbSeed: z.string(),
})

export const chapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
})

export const summarySchema = z.object({
  projectId: z.string(),
  status: z.enum(['uploading', 'processing', 'ready', 'exported', 'failed']),
  durationSec: z.number(),
  language: langSchema,
  counts: z.object({
    words: z.number(),
    sentences: z.number(),
    scenes: z.number(),
    highlights: z.number(),
    chapters: z.number(),
    silences: z.number(),
    fillers: z.number(),
  }),
  speakers: z.array(speakerSchema),
  timeline: z.object({ version: z.number(), lastVersion: z.number() }).nullable(),
  assets: z.record(z.string(), z.number()),
})

export const assetSchema = z.object({
  id: z.string(),
  kind: z.enum(['raw', 'scene_clip', 'proxy', 'export', 'thumbnail', 'audio', 'style_reel']),
  label: z.string(),
  status: z.enum(['pending', 'ready', 'failed']),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  durationSec: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  sceneId: z.string().nullable(),
  /** A short-lived link, scoped to this one file. Absent until the file is ready. */
  url: z.string().optional(),
})

export const assetListQuery = z.object({
  kind: z.enum(['raw', 'scene_clip', 'proxy', 'export', 'thumbnail', 'audio']).optional(),
})
export const assetListResponse = z.object({ assets: z.array(assetSchema), expiresIn: z.number() })

export const assetParam = z.object({ id: z.string(), assetId: z.string() })
export const assetUrlResponse = z.object({ url: z.string(), expiresIn: z.number() })
