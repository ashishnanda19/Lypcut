import { and, asc, eq, inArray } from 'drizzle-orm'
import { assets, scenes } from '../../db/schema/index.js'
import { probeMedia } from '../../lib/ffprobe.js'
import { proxyKey, sceneClipKey } from '../../lib/storage-keys.js'
import { cutClip, keyframeTimes, makeProxy, onKeyframe } from '../../media/transform.js'
import { ensureRaw, type Stage } from '../context.js'
import { uploadFrom } from '../workdir.js'

/** Share of this stage given to cutting the scene clips; the rest goes to the proxy. */
const CLIPS_SHARE = 0.6

/**
 * Stage 3: split the original into one clip per scene, and make one lightweight proxy of the whole video for
 * smooth scrubbing in the editor. A clip whose start is on a keyframe is copied without re-encoding
 * (instant and lossless); only the others are re-encoded. No HLS or DASH. Each file is uploaded and deleted
 * from disk straight away, so disk use stays at about one clip however many scenes there are.
 */
export const splitProxy: Stage = {
  key: 'split_proxy',
  step: 1,
  from: 20,
  to: 50,
  async run(ctx) {
    const { db } = ctx.deps.database
    const { storage, config } = ctx.deps
    const { file } = await ensureRaw(ctx)
    const duration = Number(ctx.prior.probe?.durationSec)
    const width = Number(ctx.prior.probe?.width)
    const height = Number(ctx.prior.probe?.height)

    const sceneRows = await db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, ctx.project.id))
      .orderBy(asc(scenes.idx))
    const keys = await keyframeTimes(file, { signal: ctx.signal })

    const clips: Array<typeof assets.$inferInsert> = []
    let copied = 0
    for (const [i, scene] of sceneRows.entries()) {
      const mode = onKeyframe(keys, scene.startSec) ? 'copy' : 'reencode'
      if (mode === 'copy') copied++
      const name = `scene-${i}.mp4`
      await cutClip(file, ctx.work.file(name), scene.startSec, scene.endSec, mode, {
        signal: ctx.signal,
      })
      const key = sceneClipKey(ctx.project.ownerId, ctx.project.id, i)
      const bytes = await uploadFrom(storage, key, ctx.work.file(name), 'video/mp4')
      ctx.work.remove(name)
      clips.push({
        projectId: ctx.project.id,
        kind: 'scene_clip',
        status: 'ready',
        storageKey: key,
        label: scene.label,
        mimeType: 'video/mp4',
        sizeBytes: bytes,
        durationSec: scene.endSec - scene.startSec,
        width,
        height,
        sceneId: scene.id,
        metadata: { cut: mode },
      })
      ctx.progress((CLIPS_SHARE * (i + 1)) / sceneRows.length)
    }

    // The proxy: whole video, at most 540p, a keyframe every second.
    await makeProxy(file, ctx.work.file('proxy.mp4'), {
      signal: ctx.signal,
      onProgress: (sec) =>
        ctx.progress(CLIPS_SHARE + (1 - CLIPS_SHARE) * Math.min(0.99, sec / Math.max(duration, 1))),
    })
    const info = await probeMedia(ctx.work.file('proxy.mp4'), { bin: config.FFPROBE_BIN })
    const proxyStorageKey = proxyKey(ctx.project.ownerId, ctx.project.id)
    const proxyBytes = await uploadFrom(
      storage,
      proxyStorageKey,
      ctx.work.file('proxy.mp4'),
      'video/mp4',
    )
    ctx.work.remove('proxy.mp4')

    await db.transaction(async (tx) => {
      await tx
        .delete(assets)
        .where(
          and(eq(assets.projectId, ctx.project.id), inArray(assets.kind, ['scene_clip', 'proxy'])),
        )
      for (let i = 0; i < clips.length; i += 500)
        await tx.insert(assets).values(clips.slice(i, i + 500))
      await tx.insert(assets).values({
        projectId: ctx.project.id,
        kind: 'proxy',
        status: 'ready',
        storageKey: proxyStorageKey,
        label: `Editing proxy (${info.height}p)`,
        mimeType: 'video/mp4',
        sizeBytes: proxyBytes,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        codec: info.videoCodec,
      })
    })

    return {
      clips: clips.length,
      copied,
      reencoded: clips.length - copied,
      proxyHeight: info.height,
    }
  },
}
