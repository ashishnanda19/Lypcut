import { z } from 'zod'
import type { jobs } from '../../db/schema/index.js'

/** The front end's `Job` type (src/types/index.ts). */
export const jobSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  kind: z.enum(['processing', 'export', 'otio']),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  progress: z.number(),
  step: z.number().optional(),
  detail: z.string().optional(),
  error: z.string().optional(),
  found: z
    .object({
      language: z.string().optional(),
      speakers: z.number().optional(),
      scenes: z.number().optional(),
      hooks: z.number().optional(),
    })
    .optional(),
  resultUrl: z.string().optional(),
})
export type JobDto = z.infer<typeof jobSchema>

type JobRow = typeof jobs.$inferSelect

const KINDS = new Set(['processing', 'export', 'otio'])

/** Internal bookkeeping jobs (cleanups) are never shown to the front end. */
export const isUserVisibleJob = (row: Pick<JobRow, 'type'>) => KINDS.has(row.type)

export function toJobDto(row: JobRow, extra: { resultUrl?: string } = {}): JobDto {
  const found = Object.fromEntries(Object.entries(row.found).filter(([, v]) => v !== undefined))
  return {
    id: row.id,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    kind: row.type as JobDto['kind'],
    // 'cancelled' (a deleted project) is shown as failed: the front end has no such state.
    status: row.status === 'cancelled' ? 'failed' : row.status,
    progress: row.progress,
    ...(row.step !== null ? { step: row.step } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(Object.keys(found).length ? { found } : {}),
    ...(extra.resultUrl ? { resultUrl: extra.resultUrl } : {}),
  }
}
