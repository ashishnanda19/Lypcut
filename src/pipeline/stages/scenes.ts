import fs from 'node:fs'
import { and, eq, inArray } from 'drizzle-orm'
import { assets, scenes, silences } from '../../db/schema/index.js'
import { uuidv7 } from '../../lib/ids.js'
import { thumbnailKey } from '../../lib/storage-keys.js'
import { buildScenes, detectCuts, detectSilences, sceneLabel } from '../../media/scenes.js'
import { makeThumbnail } from '../../media/transform.js'
import { ensureRaw, insertInChunks, type Stage } from '../context.js'

/**
 * Stage 2: find the scenes. Picture cuts come from FFmpeg's scene score; a long unbroken shot (a talking
 * head, which has no cuts at all) is split at a pause so the timeline has clips a person can work with. A
 * thumbnail is made for every scene. Safe to run again: it replaces what an earlier run left.
 */
export const scenesStage: Stage = {
  key: 'scenes',
  step: 1,
  from: 5,
  to: 20,
  async run(ctx) {
    const { db } = ctx.deps.database
    const { config, storage } = ctx.deps
    const { file } = await ensureRaw(ctx)
    const duration = Number(ctx.prior.probe?.durationSec)
    const hasAudio = Boolean(ctx.prior.probe?.hasAudio)

    const cuts = await detectCuts(file, { threshold: config.SCENE_THRESHOLD, signal: ctx.signal })
    ctx.progress(0.35)
    const quiet = hasAudio ? await detectSilences(file, { signal: ctx.signal }) : []
    ctx.progress(0.5)

    const ranges = buildScenes(cuts, duration, quiet, {
      minSceneSec: config.MIN_SCENE_SEC,
      maxSceneSec: config.MAX_SCENE_SEC,
    })

    // One thumbnail per scene, from just inside it, so it never shows the previous scene's last frame.
    const thumbs: Array<{ id: string; key: string; bytes: number; label: string }> = []
    for (const [i, r] of ranges.entries()) {
      const local = ctx.work.file(`thumb-${i}.jpg`)
      await makeThumbnail(file, r.start + Math.min(0.5, (r.end - r.start) / 2), local, {
        signal: ctx.signal,
      })
      const key = thumbnailKey(ctx.project.ownerId, ctx.project.id, i)
      const buf = fs.readFileSync(local)
      await storage.putObject(key, buf, 'image/jpeg')
      ctx.work.remove(`thumb-${i}.jpg`)
      thumbs.push({ id: uuidv7(), key, bytes: buf.length, label: `Thumbnail ${i + 1}` })
      ctx.progress(0.5 + (0.5 * (i + 1)) / ranges.length)
    }

    await db.transaction(async (tx) => {
      // Replace, never add to, what an earlier attempt left behind.
      await tx.delete(scenes).where(eq(scenes.projectId, ctx.project.id))
      await tx.delete(silences).where(eq(silences.projectId, ctx.project.id))
      await tx
        .delete(assets)
        .where(
          and(
            eq(assets.projectId, ctx.project.id),
            inArray(assets.kind, ['thumbnail', 'scene_clip']),
          ),
        )

      await insertInChunks(thumbs, (batch) =>
        tx.insert(assets).values(
          batch.map((t) => ({
            id: t.id,
            projectId: ctx.project.id,
            kind: 'thumbnail' as const,
            status: 'ready' as const,
            storageKey: t.key,
            label: t.label,
            mimeType: 'image/jpeg',
            sizeBytes: t.bytes,
          })),
        ),
      )
      await insertInChunks(
        ranges.map((r, i) => ({
          projectId: ctx.project.id,
          idx: i,
          label: sceneLabel(i),
          startSec: r.start,
          endSec: r.end,
          score: r.score,
          keyframes: [] as number[],
          thumbnailAssetId: thumbs[i]!.id,
        })),
        (batch) => tx.insert(scenes).values(batch),
      )
      if (quiet.length) {
        await insertInChunks(
          quiet.map((q) => ({ projectId: ctx.project.id, startSec: q.start, endSec: q.end })),
          (batch) => tx.insert(silences).values(batch),
        )
      }
    })

    await ctx.report.update({ found: { scenes: ranges.length } })
    return { sceneCount: ranges.length, silences: quiet.length, cuts: cuts.length }
  },
}
