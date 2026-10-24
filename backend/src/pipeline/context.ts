import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { AppDeps } from '../app/types.js'
import { assets } from '../db/schema/index.js'
import type { jobs, projects } from '../db/schema/index.js'
import type { Log } from '../lib/log.js'
import type { TranscriptionProvider } from '../transcription/types.js'
import { PermanentError } from './errors.js'
import type { Reporter } from './reporter.js'
import { downloadTo, type WorkDir } from './workdir.js'

type JobRow = typeof jobs.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type AssetRow = typeof assets.$inferSelect

/** What every stage gets: the world it may touch, and where to report progress. */
export interface PipelineContext {
  deps: AppDeps
  log: Log
  provider: TranscriptionProvider
  job: JobRow
  project: ProjectRow
  work: WorkDir
  /** Aborted when the project is deleted or the worker is shutting down. */
  signal: AbortSignal
  report: Reporter
  /** What each earlier stage returned, by stage key. Persisted, so a resumed job still has it. */
  prior: Record<string, Record<string, unknown>>
  /** The original video once downloaded in this attempt. */
  raw?: { file: string; asset: AssetRow; sha256?: string }
  /** Report how far through the current stage we are, 0 to 1. */
  progress(fraction: number): void
}

export interface Stage {
  key: string
  /** Index of the user-facing step this stage belongs to (0-4), as the Processing screen shows it. */
  step: number
  /** Overall progress (0-100) when the stage starts and when it ends. */
  from: number
  to: number
  run(ctx: PipelineContext): Promise<Record<string, unknown>>
}

/** The Processing screen's step names, in the exact words the front end uses. */
export const STEP_LABELS = [
  'Uploaded',
  'Splitting into clips',
  'Transcribing',
  'Indexing scenes and speakers',
  'Ready',
] as const

export const languageLabel = (lang: 'hi' | 'hinglish' | 'en'): string =>
  lang === 'hinglish' ? 'Hinglish (Hindi + English)' : lang === 'hi' ? 'Hindi' : 'English'

/**
 * The original video on local disk, downloaded once per attempt (and hashed on the way). Stages are
 * independent and may run on different workers, so each one asks for what it needs rather than assuming.
 */
export async function ensureRaw(
  ctx: PipelineContext,
): Promise<NonNullable<PipelineContext['raw']>> {
  if (ctx.raw) return ctx.raw
  const { db } = ctx.deps.database
  const [asset] = await db
    .select()
    .from(assets)
    .where(
      and(eq(assets.projectId, ctx.project.id), eq(assets.kind, 'raw'), eq(assets.status, 'ready')),
    )
  if (!asset) throw new PermanentError('The original video could not be found.', 'RAW_MISSING')

  const name = `raw${path.extname(asset.storageKey) || '.mp4'}`
  const file = ctx.work.file(name)
  let sha256: string | undefined
  if (!ctx.work.exists(name, asset.sizeBytes ?? undefined)) {
    sha256 = await downloadTo(ctx.deps.storage, asset.storageKey, file, ctx.signal)
  }
  ctx.raw = { file, asset, sha256 }
  return ctx.raw
}

/** Inserts rows in batches, so a three-hour transcript does not become one enormous statement. */
export async function insertInChunks<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  size = 1000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size))
}
