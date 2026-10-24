import path from 'node:path'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Log } from '../../lib/log.js'
import type { AppDeps } from '../../app/types.js'
import { assets, jobs, projects, reels, uploads, usageEvents } from '../../db/schema/index.js'
import { AppError, err } from '../../lib/errors.js'
import { sha256Stream } from '../../lib/hash.js'
import { probeMedia, type MediaInfo } from '../../lib/ffprobe.js'
import { requireProject, requireUpload } from '../../lib/ownership.js'
import {
  limitsFor,
  monthlyUploadsProblem,
  reelLengthProblem,
  styleLimitsFor,
  videoLengthProblem,
  type PlanId,
} from '../../lib/plans.js'
import { uuidv7 } from '../../lib/ids.js'
import { rawKey, styleReelKey } from '../../lib/storage-keys.js'
import { enqueueJob } from '../../queue/enqueue.js'
import { toJobDto } from '../jobs/dto.js'
import { ProjectService, ACTIVE_UPLOAD_STATES, uploadsUsedThisMonth } from '../projects/service.js'
import type { UploadDto } from './schema.js'

type UploadRow = typeof uploads.$inferSelect
type User = { id: string; plan: PlanId }

const MiB = 1024 * 1024
const MAX_PARTS = 10_000

/** Accepted by file extension (cheap, early). The real check is ffprobe looking inside the file. */
const EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
}
const DECLARED_TYPES = new Set([
  ...Object.values(EXTENSIONS),
  'video/x-m4v',
  'application/octet-stream',
  '',
])

/** Pieces of at least `configuredMb`, and never more than S3's 10,000 parts. */
export function planParts(sizeBytes: number, configuredMb: number) {
  let partSize = configuredMb * MiB
  if (Math.ceil(sizeBytes / partSize) > MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / MAX_PARTS / MiB) * MiB
  }
  return { partSize, totalParts: Math.ceil(sizeBytes / partSize) }
}

const expired = () =>
  new AppError(410, 'UPLOAD_EXPIRED', 'This upload expired. Start it again to continue.')

/**
 * The project an upload belongs to. Only a style Reel's upload has none, and it is completed by the style module, never
 * here, so a missing project is a bug, not a user error.
 */
function projectOf(row: UploadRow): string {
  if (!row.projectId) throw new Error(`upload ${row.id} has no project`)
  return row.projectId
}

export class UploadService {
  private readonly projects: ProjectService

  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {
    this.projects = new ProjectService(deps, log)
  }

  private get db() {
    return this.deps.database.db
  }
  private get storage() {
    return this.deps.storage
  }
  private get cfg() {
    return this.deps.config
  }

  /* ------------------------------- start ------------------------------ */

  async start(
    user: User,
    input: {
      projectId?: string
      purpose?: 'style_reel'
      fileName: string
      contentType?: string
      sizeBytes: number
      durationSec?: number
    },
  ): Promise<{ upload: UploadDto; resumed: boolean }> {
    if (!input.projectId) return this.startStyleReel(user, input)
    const project = await requireProject(this.db, user.id, input.projectId)
    if (project.status !== 'uploading') {
      throw err.conflict('CONFLICT', 'This project already has its video.')
    }

    const ext = path.extname(input.fileName).toLowerCase()
    const canonicalType = EXTENSIONS[ext]
    if (!canonicalType || !DECLARED_TYPES.has((input.contentType ?? '').toLowerCase())) {
      throw err.unsupported('Upload an MP4, MOV, MKV, WebM or AVI video.')
    }
    if (input.sizeBytes > this.cfg.MAX_UPLOAD_BYTES) {
      throw err.tooLarge(
        `That file is larger than the ${Math.round(this.cfg.MAX_UPLOAD_BYTES / 1024 ** 3)} GB limit.`,
      )
    }

    const limits = limitsFor(user.plan)
    // Early, cheap check on the length the browser reported. The real one is ffprobe, after upload.
    if (input.durationSec !== undefined) {
      const tooLong = videoLengthProblem(limits, input.durationSec)
      if (tooLong) {
        throw err.limit('LIMIT_VIDEO_LENGTH', tooLong, { maxSeconds: limits.maxVideoSeconds })
      }
    }

    const { partSize, totalParts } = planParts(input.sizeBytes, this.cfg.UPLOAD_PART_SIZE_MB)
    const now = new Date()
    let createdUploadId: string | undefined
    let createdKey: string | undefined

    try {
      return await this.db.transaction(async (tx) => {
        // One upload start at a time per user, so two tabs cannot both slip under the monthly limit.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upload:${user.id}`}::text))`)

        const [existing] = await tx
          .select()
          .from(uploads)
          .where(
            and(
              eq(uploads.projectId, project.id),
              inArray(uploads.status, [...ACTIVE_UPLOAD_STATES]),
            ),
          )
        if (existing && existing.expiresAt > now) {
          // Starting the same upload again resumes it instead of making a second one.
          if (existing.fileName === input.fileName && existing.sizeBytes === input.sizeBytes) {
            return { upload: this.toDto(existing), resumed: true }
          }
          throw err.conflict('CONFLICT', 'This project already has an upload in progress.', {
            uploadId: existing.id,
          })
        }
        if (existing) await this.expire(existing)

        const used = await uploadsUsedThisMonth(this.db, user.id, now)
        const quota = monthlyUploadsProblem(limits, used)
        if (quota) {
          throw err.limit('LIMIT_MONTHLY_UPLOADS', quota, { max: limits.maxUploadsPerMonth })
        }

        const assetId = uuidv7()
        const key = rawKey(user.id, project.id, assetId, ext)
        createdKey = key
        createdUploadId = await this.storage.createMultipart(key, canonicalType)

        await tx.insert(assets).values({
          id: assetId,
          projectId: project.id,
          kind: 'raw',
          status: 'pending',
          storageKey: key,
          label: input.fileName,
          mimeType: canonicalType,
          sizeBytes: input.sizeBytes,
        })
        const [row] = await tx
          .insert(uploads)
          .values({
            userId: user.id,
            projectId: project.id,
            assetId,
            fileName: input.fileName,
            contentType: canonicalType,
            sizeBytes: input.sizeBytes,
            declaredDurationSec: input.durationSec,
            storageKey: key,
            s3UploadId: createdUploadId,
            partSize,
            totalParts,
            expiresAt: new Date(now.getTime() + this.cfg.UPLOAD_TTL_HOURS * 3600_000),
          })
          .returning()
        return { upload: this.toDto(row!), resumed: false }
      })
    } catch (e) {
      // The database refused after storage had already opened the upload: do not leave it behind.
      if (createdKey && createdUploadId) {
        await this.storage.abortMultipart(createdKey, createdUploadId).catch(() => undefined)
      }
      throw e
    }
  }

  /**
   * A Reel for style learning. The same resumable upload as a project's video, with no project: it is limited by how many
   * Reels the person already has (not by the monthly project quota) and by the Reel length limit, and it ends up as a
   * `style_reel` asset under the person's style folder.
   */
  private async startStyleReel(
    user: User,
    input: { fileName: string; contentType?: string; sizeBytes: number; durationSec?: number },
  ): Promise<{ upload: UploadDto; resumed: boolean }> {
    const ext = path.extname(input.fileName).toLowerCase()
    const canonicalType = EXTENSIONS[ext]
    if (!canonicalType || !DECLARED_TYPES.has((input.contentType ?? '').toLowerCase())) {
      throw err.unsupported('Upload an MP4, MOV, MKV, WebM or AVI video.')
    }
    if (input.sizeBytes > this.cfg.STYLE_MAX_REEL_BYTES) {
      throw err.tooLarge(
        `A Reel can be up to ${Math.round(this.cfg.STYLE_MAX_REEL_BYTES / MiB)} MB.`,
      )
    }
    const limits = styleLimitsFor(user.plan)
    if (input.durationSec !== undefined) {
      const tooLong = reelLengthProblem(limits, input.durationSec)
      if (tooLong)
        throw err.limit('LIMIT_REEL_LENGTH', tooLong, { maxSeconds: limits.maxReelSeconds })
    }

    const { partSize, totalParts } = planParts(input.sizeBytes, this.cfg.UPLOAD_PART_SIZE_MB)
    const now = new Date()
    let createdUploadId: string | undefined
    let createdKey: string | undefined
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upload:${user.id}`}::text))`)

        const mine = and(eq(uploads.userId, user.id), isNull(uploads.projectId))
        const active = await tx
          .select()
          .from(uploads)
          .where(and(mine, inArray(uploads.status, [...ACTIVE_UPLOAD_STATES])))
        const same = active.find(
          (u) =>
            u.fileName === input.fileName && u.sizeBytes === input.sizeBytes && u.expiresAt > now,
        )
        // Starting the same file again resumes it instead of making a second one.
        if (same) return { upload: this.toDto(same), resumed: true }

        const [{ n: have } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(reels)
          .where(and(eq(reels.userId, user.id), eq(reels.source, 'upload')))
        const inFlight = active.filter((u) => u.expiresAt > now).length
        if (have + inFlight >= limits.maxUploadedReels) {
          throw err.limit(
            'LIMIT_STYLE_REELS',
            `You can have up to ${limits.maxUploadedReels} Reels for style learning. Remove one to add another.`,
            { max: limits.maxUploadedReels },
          )
        }

        const assetId = uuidv7()
        const key = styleReelKey(user.id, assetId, ext)
        createdKey = key
        createdUploadId = await this.storage.createMultipart(key, canonicalType)
        await tx.insert(assets).values({
          id: assetId,
          userId: user.id,
          kind: 'style_reel',
          status: 'pending',
          storageKey: key,
          label: input.fileName,
          mimeType: canonicalType,
          sizeBytes: input.sizeBytes,
        })
        const [row] = await tx
          .insert(uploads)
          .values({
            userId: user.id,
            assetId,
            fileName: input.fileName,
            contentType: canonicalType,
            sizeBytes: input.sizeBytes,
            declaredDurationSec: input.durationSec,
            storageKey: key,
            s3UploadId: createdUploadId,
            partSize,
            totalParts,
            expiresAt: new Date(now.getTime() + this.cfg.UPLOAD_TTL_HOURS * 3600_000),
          })
          .returning()
        return { upload: this.toDto(row!), resumed: false }
      })
    } catch (e) {
      if (createdKey && createdUploadId) {
        await this.storage.abortMultipart(createdKey, createdUploadId).catch(() => undefined)
      }
      throw e
    }
  }

  /* -------------------------------- state ----------------------------- */

  /** The upload's state, with the parts storage actually holds, so a client can resume. */
  async get(userId: string, uploadId: string): Promise<UploadDto> {
    const row = await requireUpload(this.db, userId, uploadId)
    if (!this.isActive(row)) return this.toDto(row)
    if (row.expiresAt <= new Date()) {
      await this.expire(row)
      return this.toDto({ ...row, status: 'expired' })
    }
    return this.toDto(await this.refreshParts(row))
  }

  private isActive(row: UploadRow) {
    return (ACTIVE_UPLOAD_STATES as readonly string[]).includes(row.status)
  }

  /** Storage is the source of truth for which parts arrived; the row is just a cache of it. */
  private async refreshParts(row: UploadRow): Promise<UploadRow> {
    const parts = await this.storage.listParts(row.storageKey, row.s3UploadId)
    const status = row.status === 'initiated' && parts.length ? 'uploading' : row.status
    const [updated] = await this.db
      .update(uploads)
      .set({ partsReceived: parts, status })
      .where(eq(uploads.id, row.id))
      .returning()
    return updated!
  }

  /* --------------------------- presigned parts ------------------------ */

  async presignParts(userId: string, uploadId: string, partNumbers: number[]) {
    const row = await requireUpload(this.db, userId, uploadId)
    if (row.status === 'expired') throw expired()
    if (!['initiated', 'uploading'].includes(row.status)) {
      throw err.conflict('CONFLICT', `This upload is ${row.status} and cannot take more parts.`)
    }
    if (row.expiresAt <= new Date()) {
      await this.expire(row)
      throw expired()
    }
    const bad = partNumbers.filter((n) => n > row.totalParts)
    if (bad.length) {
      throw err.validation(`This upload has ${row.totalParts} parts.`, {
        field: 'partNumbers',
        invalid: bad,
      })
    }
    if (row.status === 'initiated') {
      await this.db.update(uploads).set({ status: 'uploading' }).where(eq(uploads.id, row.id))
    }
    const ttl = this.cfg.PRESIGN_PUT_TTL_SEC
    const urls = await Promise.all(
      [...new Set(partNumbers)].map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignPart(row.storageKey, row.s3UploadId, partNumber, ttl),
      })),
    )
    return { urls, expiresIn: ttl }
  }

  /* ------------------------------- complete --------------------------- */

  async complete(user: User, uploadId: string, input: { checksum?: string } = {}) {
    const row = await requireUpload(this.db, user.id, uploadId)
    if (row.status === 'completed') return this.completedResult(row)
    if (row.status === 'expired') throw expired()
    if (!['initiated', 'uploading'].includes(row.status)) {
      throw err.conflict(
        'CONFLICT',
        row.status === 'completing'
          ? 'This upload is already being finished.'
          : `This upload is ${row.status}.`,
      )
    }
    if (row.expiresAt <= new Date()) {
      await this.expire(row)
      throw expired()
    }

    // Claim it, so two completes cannot race.
    const [claimed] = await this.db
      .update(uploads)
      .set({ status: 'completing' })
      .where(and(eq(uploads.id, row.id), inArray(uploads.status, ['initiated', 'uploading'])))
      .returning()
    if (!claimed) throw err.conflict('CONFLICT', 'This upload is already being finished.')

    // 1. Are all the parts there, and the right size? Fixable by the client, so nothing is thrown away.
    let parts
    try {
      parts = await this.storage.listParts(row.storageKey, row.s3UploadId)
      this.assertParts(row, parts)
    } catch (e) {
      await this.db.update(uploads).set({ status: 'uploading' }).where(eq(uploads.id, row.id))
      throw e
    }

    // 2. From here the upload is stitched together; any failure is final and the file is removed.
    try {
      await this.storage.completeMultipart(
        row.storageKey,
        row.s3UploadId,
        parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      )
      const stored = await this.storage.head(row.storageKey)
      if (!stored || stored.size !== row.sizeBytes) {
        throw new AppError(
          422,
          'UPLOAD_INCOMPLETE',
          'The file that arrived is not the size you said it was. Please upload it again.',
        )
      }

      if (input.checksum) {
        const actual = await sha256Stream(await this.storage.getStream(row.storageKey))
        if (actual !== input.checksum) {
          throw new AppError(
            422,
            'CHECKSUM_MISMATCH',
            'The file was damaged on the way. Please upload it again.',
          )
        }
      }

      // Look inside the file, never at its name or what the browser claimed. Only the header is read.
      const url = await this.storage.presignInternalGet(row.storageKey, 300)
      const media = await probeMedia(url, { bin: this.cfg.FFPROBE_BIN })

      if (!row.projectId) {
        const limits = styleLimitsFor(user.plan)
        const tooLong = reelLengthProblem(limits, media.durationSec)
        if (tooLong) {
          throw err.limit('LIMIT_REEL_LENGTH', tooLong, {
            maxSeconds: limits.maxReelSeconds,
            durationSec: Math.round(media.durationSec),
          })
        }
        return await this.acceptStyleReel(user, row, media, parts, input.checksum)
      }
      const tooLong = videoLengthProblem(limitsFor(user.plan), media.durationSec)
      if (tooLong) {
        throw err.limit('LIMIT_VIDEO_LENGTH', tooLong, {
          maxSeconds: limitsFor(user.plan).maxVideoSeconds,
          durationSec: Math.round(media.durationSec),
        })
      }
      return await this.accept(user, row, media, parts, input.checksum)
    } catch (e) {
      if (e instanceof AppError) {
        // A refusal about the file itself: remove it and free the slot, so the user can try another.
        await this.discard(row)
      } else {
        // An infrastructure problem: leave the finished object, let the client retry complete.
        await this.db.update(uploads).set({ status: 'uploading' }).where(eq(uploads.id, row.id))
        this.log.error({ err: e, uploadId: row.id }, 'completing an upload failed')
      }
      throw e
    }
  }

  private assertParts(row: UploadRow, parts: Array<{ partNumber: number; size: number }>) {
    const byNumber = new Map(parts.map((p) => [p.partNumber, p.size]))
    const missing: number[] = []
    const wrongSize: number[] = []
    for (let n = 1; n <= row.totalParts; n++) {
      const size = byNumber.get(n)
      if (size === undefined) {
        missing.push(n)
        continue
      }
      const expectedSize =
        n < row.totalParts ? row.partSize : row.sizeBytes - row.partSize * (row.totalParts - 1)
      if (size !== expectedSize) wrongSize.push(n)
    }
    if (missing.length || wrongSize.length) {
      throw new AppError(
        422,
        'UPLOAD_INCOMPLETE',
        missing.length
          ? 'Some parts of the file have not arrived yet.'
          : 'Some parts arrived at the wrong size. Send them again.',
        { missing, wrongSize },
      )
    }
  }

  /** The file passed every check: make it the project's video and queue processing. */
  private async accept(
    user: User,
    row: UploadRow,
    media: MediaInfo,
    parts: UploadRow['partsReceived'],
    checksum?: string,
  ) {
    const result = await this.db.transaction(async (tx) => {
      await tx
        .update(assets)
        .set({
          status: 'ready',
          durationSec: media.durationSec,
          width: media.width,
          height: media.height,
          codec: media.videoCodec,
          checksum: checksum ?? null,
          metadata: {
            format: media.formatName,
            bitRate: media.bitRate,
            fps: media.fps,
            audioCodec: media.audioCodec,
            hasAudio: media.hasAudio,
          },
        })
        .where(eq(assets.id, row.assetId))
      await tx
        .update(projects)
        .set({ status: 'processing', durationSec: media.durationSec, error: null })
        .where(eq(projects.id, projectOf(row)))
      const [done] = await tx
        .update(uploads)
        .set({
          status: 'completed',
          completedAt: new Date(),
          checksum: checksum ?? null,
          partsReceived: parts,
        })
        .where(eq(uploads.id, row.id))
        .returning()
      await tx.insert(usageEvents).values([
        { userId: user.id, kind: 'upload', amount: 1, projectId: projectOf(row) },
        {
          userId: user.id,
          kind: 'video_seconds',
          amount: media.durationSec,
          projectId: projectOf(row),
        },
      ])
      const [job] = await tx
        .insert(jobs)
        .values({
          userId: user.id,
          projectId: projectOf(row),
          type: 'processing',
          step: 0,
          detail: 'Uploaded',
        })
        .returning()
      return { upload: done!, job: job! }
    })

    // If this add is lost, the worker's reconcile sweep re-enqueues the row.
    await enqueueJob(this.deps.queues, result.job).catch((e) =>
      this.log.error(
        { err: e, jobId: result.job.id },
        'could not enqueue processing; the sweep will retry',
      ),
    )
    const project = await this.projects.get(user.id, projectOf(row))
    return { upload: this.toDto(result.upload), project, job: toJobDto(result.job) }
  }

  /** A style Reel passed every check: it becomes a Reel, waiting for the person to submit their Reels for analysis. */
  private async acceptStyleReel(
    user: User,
    row: UploadRow,
    media: MediaInfo,
    parts: UploadRow['partsReceived'],
    checksum?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx
        .update(assets)
        .set({
          status: 'ready',
          durationSec: media.durationSec,
          width: media.width,
          height: media.height,
          codec: media.videoCodec,
          checksum: checksum ?? null,
          metadata: { format: media.formatName, fps: media.fps, hasAudio: media.hasAudio },
        })
        .where(eq(assets.id, row.assetId))
      const [done] = await tx
        .update(uploads)
        .set({
          status: 'completed',
          completedAt: new Date(),
          checksum: checksum ?? null,
          partsReceived: parts,
        })
        .where(eq(uploads.id, row.id))
        .returning()
      const [reel] = await tx
        .insert(reels)
        .values({
          userId: user.id,
          source: 'upload',
          assetId: row.assetId,
          label: row.fileName.replace(/\.[^./\\]+$/, '').slice(0, 120) || 'Reel',
          durationSec: media.durationSec,
          contentHash: checksum ?? null,
        })
        .returning()
      return {
        upload: this.toDto(done!),
        reel: { id: reel!.id, label: reel!.label, durationSec: reel!.durationSec },
      }
    })
  }

  private async completedResult(row: UploadRow) {
    if (!row.projectId) {
      const [reel] = await this.db.select().from(reels).where(eq(reels.assetId, row.assetId))
      if (!reel) throw err.conflict('CONFLICT', 'This Reel has already been used or removed.')
      return {
        upload: this.toDto(row),
        reel: { id: reel.id, label: reel.label, durationSec: reel.durationSec },
      }
    }
    const project = await this.projects.get(row.userId, projectOf(row))
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectOf(row)), eq(jobs.type, 'processing')))
      .orderBy(sql`${jobs.createdAt} desc`)
      .limit(1)
    return { upload: this.toDto(row), project, job: toJobDto(job!) }
  }

  /* ------------------------------- abort ------------------------------ */

  async abort(userId: string, uploadId: string): Promise<void> {
    const row = await requireUpload(this.db, userId, uploadId)
    if (row.status === 'completed' || row.status === 'completing') {
      throw err.conflict('CONFLICT', 'This upload is already finished.')
    }
    if (this.isActive(row)) {
      await this.storage.abortMultipart(row.storageKey, row.s3UploadId)
      await this.close(row, 'aborted')
    }
  }

  /* ------------------------------ lifecycle --------------------------- */

  /** Marks an upload expired and releases what it held in storage. */
  async expire(row: UploadRow): Promise<void> {
    await this.storage.abortMultipart(row.storageKey, row.s3UploadId).catch((e) => {
      this.log.warn({ err: e, uploadId: row.id }, 'could not abort an expired upload')
    })
    await this.close(row, 'expired')
  }

  /** An upload whose completion never finished: remove whatever it left and mark it failed. */
  async failStuck(row: UploadRow): Promise<void> {
    await this.storage.abortMultipart(row.storageKey, row.s3UploadId).catch(() => undefined)
    await this.discard(row)
  }

  /** A finished-but-refused file: delete the object and mark the upload failed. */
  private async discard(row: UploadRow): Promise<void> {
    await this.storage.delete(row.storageKey).catch((e) => {
      this.log.warn({ err: e, uploadId: row.id }, 'could not remove a rejected file')
    })
    await this.close(row, 'failed')
  }

  private async close(row: UploadRow, status: 'aborted' | 'expired' | 'failed'): Promise<void> {
    await this.db.update(uploads).set({ status }).where(eq(uploads.id, row.id))
    await this.db.update(assets).set({ status: 'failed' }).where(eq(assets.id, row.assetId))
  }

  /* -------------------------------- dto ------------------------------- */

  toDto(row: UploadRow): UploadDto {
    return {
      id: row.id,
      projectId: row.projectId,
      status: row.status,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      partSize: row.partSize,
      totalParts: row.totalParts,
      parts: row.partsReceived.map((p) => ({ partNumber: p.partNumber, size: p.size })),
      bytesReceived: row.partsReceived.reduce((sum, p) => sum + p.size, 0),
      expiresAt: row.expiresAt.toISOString(),
    }
  }
}
