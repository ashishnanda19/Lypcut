import { z } from 'zod'
import { jobSchema } from '../jobs/dto.js'
import { projectSchema } from '../projects/schema.js'

export const uploadStatusSchema = z.enum([
  'initiated',
  'uploading',
  'completing',
  'completed',
  'aborted',
  'expired',
  'failed',
])

export const uploadSchema = z.object({
  id: z.string(),
  /** Null for a style Reel's upload, which belongs to the person and not to a project. */
  projectId: z.string().nullable(),
  status: uploadStatusSchema,
  fileName: z.string(),
  sizeBytes: z.number(),
  /** Every part except the last is exactly this long. */
  partSize: z.number(),
  totalParts: z.number(),
  /** Parts storage already holds. A client resuming sends only the ones missing from this list. */
  parts: z.array(z.object({ partNumber: z.number(), size: z.number() })),
  bytesReceived: z.number(),
  expiresAt: z.string(),
})
export type UploadDto = z.infer<typeof uploadSchema>

export const startUploadBody = z
  .object({
    /** The project the video is for. Leave it out, and send `purpose`, for a Reel that teaches the assistant your style. */
    projectId: z.string().optional(),
    purpose: z.literal('style_reel').optional(),
    fileName: z.string().trim().min(1, 'Choose a video file.').max(255),
    /** The type the browser reports. Informational: the file is checked by its content on completion. */
    contentType: z.string().max(100).optional(),
    sizeBytes: z.number().int().positive('That file is empty.'),
    /** What the browser read from the file. Used for an early limit check only, never trusted. */
    durationSec: z
      .number()
      .min(0)
      .max(24 * 3600)
      .optional(),
  })
  .refine((b) => (b.projectId === undefined) === (b.purpose === 'style_reel'), {
    message: 'Send a projectId, or purpose "style_reel" without one.',
    path: ['projectId'],
  })

export const presignPartsBody = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
})

export const presignPartsResponse = z.object({
  urls: z.array(z.object({ partNumber: z.number(), url: z.string() })),
  /** Seconds the URLs stay valid. */
  expiresIn: z.number(),
})

export const completeUploadBody = z
  .object({
    /** SHA-256 of the whole file, hex. If sent, it is verified against what was stored. */
    checksum: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'The checksum must be a SHA-256 in hex.')
      .transform((s) => s.toLowerCase())
      .optional(),
  })
  .nullish()

export const completeUploadResponse = z.object({
  upload: uploadSchema,
  project: projectSchema,
  job: jobSchema,
})

/** What finishing a style Reel's upload returns: the Reel, waiting to be analysed once the person submits their Reels. */
export const completeStyleUploadResponse = z.object({
  upload: uploadSchema,
  reel: z.object({ id: z.string(), label: z.string(), durationSec: z.number().nullable() }),
})
