import { z } from 'zod'
import { langSchema } from '../account/schema.js'

export const idParam = z.object({ id: z.string() })

/** The front end's `Asset` and `Project` types (src/types/index.ts). */
export const assetSchema = z.object({
  id: z.string(),
  kind: z.enum(['raw', 'clip', 'proxy']),
  label: z.string(),
  durationSec: z.number(),
  url: z.string().optional(),
})

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['uploading', 'processing', 'ready', 'exported', 'failed']),
  durationSec: z.number(),
  language: langSchema,
  thumbSeed: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.number().optional(),
  jobId: z.string().optional(),
  hooksFound: z.number().optional(),
  assets: z.array(assetSchema),
})
export type ProjectDto = z.infer<typeof projectSchema>

export const createProjectBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  fileName: z.string().trim().min(1, 'Choose a video file.').max(255),
  /** What the browser read from the file. Used for an early limit check only, never trusted. */
  durationSec: z
    .number()
    .min(0)
    .max(24 * 3600)
    .optional(),
})

export const renameProjectBody = z.object({
  title: z.string().trim().min(1, 'Give the project a name.').max(120, 'Use a shorter name.'),
})
