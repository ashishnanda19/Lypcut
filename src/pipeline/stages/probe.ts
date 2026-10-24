import { eq } from 'drizzle-orm'
import { assets, uploads } from '../../db/schema/index.js'
import { AppError } from '../../lib/errors.js'
import { probeMedia } from '../../lib/ffprobe.js'
import { ensureRaw, type Stage } from '../context.js'
import { PermanentError } from '../errors.js'

/**
 * Stage 1: read the original once, from storage to disk as a stream. This is where the whole file is first
 * read, so it is where its SHA-256 is computed (and checked against the one the client declared), and where
 * ffprobe confirms what it is.
 */
export const probe: Stage = {
  key: 'probe',
  step: 1,
  from: 0,
  to: 5,
  async run(ctx) {
    const { db } = ctx.deps.database
    const raw = await ensureRaw(ctx)

    if (raw.sha256) {
      const [upload] = await db.select().from(uploads).where(eq(uploads.assetId, raw.asset.id))
      if (upload?.checksum && upload.checksum !== raw.sha256) {
        throw new PermanentError(
          'The file was damaged on the way. Please upload it again.',
          'CHECKSUM_MISMATCH',
        )
      }
      await db.update(assets).set({ checksum: raw.sha256 }).where(eq(assets.id, raw.asset.id))
    }

    let media
    try {
      media = await probeMedia(raw.file, { bin: ctx.deps.config.FFPROBE_BIN })
    } catch (e) {
      // Accepted at upload but unreadable now: the person is told, a retry will not help.
      if (e instanceof AppError) throw new PermanentError(e.message, e.code)
      throw e
    }
    return {
      durationSec: media.durationSec,
      hasAudio: media.hasAudio,
      width: media.width,
      height: media.height,
      fps: media.fps,
      videoCodec: media.videoCodec,
    }
  },
}
