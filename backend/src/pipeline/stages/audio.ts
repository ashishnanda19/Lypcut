import { and, eq } from 'drizzle-orm'
import { assets } from '../../db/schema/index.js'
import { extractAudio } from '../../media/transform.js'
import { ensureRaw, type Stage } from '../context.js'
import { PermanentError } from '../errors.js'
import { uploadFrom } from '../workdir.js'
import { audioKey } from '../../lib/storage-keys.js'

/** The words the Processing screen shows when there is nothing to transcribe. They match the mock's. */
export const NO_AUDIO_MESSAGE = "We couldn't read a clear audio track from this file."

/**
 * Stage 4: pull the voice out as mono 16 kHz audio, which is what speech recognition wants, and keep it in
 * storage so a transcription retry does not have to decode the video again.
 */
export const audio: Stage = {
  key: 'audio',
  step: 2,
  from: 50,
  to: 55,
  async run(ctx) {
    if (!ctx.prior.probe?.hasAudio) throw new PermanentError(NO_AUDIO_MESSAGE, 'NO_AUDIO')

    const { db } = ctx.deps.database
    const { file } = await ensureRaw(ctx)
    await extractAudio(file, ctx.work.file('audio.wav'), { signal: ctx.signal })

    const key = audioKey(ctx.project.ownerId, ctx.project.id)
    const bytes = await uploadFrom(ctx.deps.storage, key, ctx.work.file('audio.wav'), 'audio/wav')
    await db.transaction(async (tx) => {
      await tx
        .delete(assets)
        .where(and(eq(assets.projectId, ctx.project.id), eq(assets.kind, 'audio')))
      await tx.insert(assets).values({
        projectId: ctx.project.id,
        kind: 'audio',
        status: 'ready',
        storageKey: key,
        label: 'Voice (16 kHz mono)',
        mimeType: 'audio/wav',
        sizeBytes: bytes,
        durationSec: Number(ctx.prior.probe?.durationSec),
      })
    })
    return { audioKey: key, bytes }
  },
}
