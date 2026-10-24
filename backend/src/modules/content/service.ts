import { and, asc, count, eq, gte, lte, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { AppDeps } from '../../app/types.js'
import {
  assets,
  chapters,
  highlights,
  scenes,
  silences,
  timelines,
  transcriptSentences,
  transcripts,
  transcriptWords,
} from '../../db/schema/index.js'
import { AppError, err } from '../../lib/errors.js'
import { UUID_RE } from '../../lib/ids.js'
import { requireProject } from '../../lib/ownership.js'

type Db = AppDeps['database']['db']

/** Only a finished project has content worth reading. Anything earlier is told so, rather than shown as empty. */
export async function requireReady(db: Db, userId: string, projectId: string) {
  const project = await requireProject(db, userId, projectId)
  if (project.status !== 'ready' && project.status !== 'exported') {
    throw new AppError(
      409,
      'NOT_READY',
      'This project is still being prepared. Try again in a moment.',
    )
  }
  return project
}

const countOf = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0

export class ContentService {
  constructor(private readonly deps: AppDeps) {}

  private get db() {
    return this.deps.database.db
  }

  /**
   * The transcript in the front end's shape. With no range it is the whole thing (the editor loads it once and
   * works from it). With `from` and `to` (seconds of the source) it is just the words overlapping that range; the
   * sentence indices remain global, so `range.wordOffset` says where the slice starts.
   */
  async transcript(userId: string, projectId: string, range?: { from: number; to: number }) {
    await requireReady(this.db, userId, projectId)
    const [tr] = await this.db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, projectId))
    if (!tr) throw err.notFound('Transcript')

    // Rows whose [start, end] overlaps the asked-for range (all rows when there is none).
    const inRange = (start: AnyPgColumn, end: AnyPgColumn) =>
      range ? and(lte(start, range.to), gte(end, range.from)) : undefined

    const words = await this.db
      .select()
      .from(transcriptWords)
      .where(
        and(
          eq(transcriptWords.transcriptId, tr.id),
          inRange(transcriptWords.startSec, transcriptWords.endSec),
        ),
      )
      .orderBy(asc(transcriptWords.idx))
    const sentences = await this.db
      .select()
      .from(transcriptSentences)
      .where(
        and(
          eq(transcriptSentences.transcriptId, tr.id),
          inRange(transcriptSentences.startSec, transcriptSentences.endSec),
        ),
      )
      .orderBy(asc(transcriptSentences.idx))

    return {
      language: tr.language,
      speakers: tr.speakers,
      words: words.map((w) => ({
        text: w.text,
        dev: w.dev,
        start: w.startSec,
        end: w.endSec,
        speaker: w.speaker,
        language: w.language,
        ...(w.filler ? { filler: true as const } : {}),
      })),
      sentences: sentences.map((s) => ({
        id: `s${s.idx}`,
        speaker: s.speaker,
        from: s.fromWord,
        to: s.toWord,
        start: s.startSec,
        end: s.endSec,
      })),
      ...(range ? { range: { ...range, wordOffset: words[0]?.idx ?? 0 } } : {}),
    }
  }

  async scenes(userId: string, projectId: string) {
    await requireReady(this.db, userId, projectId)
    const rows = await this.db
      .select({ scene: scenes, thumbKey: assets.storageKey })
      .from(scenes)
      .leftJoin(assets, eq(assets.id, scenes.thumbnailAssetId))
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.idx))
    const ttlSec = this.deps.config.PRESIGN_GET_TTL_SEC
    return Promise.all(
      rows.map(async ({ scene, thumbKey }) => ({
        // Matches the ids of the timeline's clips ("v_s0", "a_s0"), so a scene and its clips line up.
        id: `s${scene.idx}`,
        label: scene.label,
        start: scene.startSec,
        end: scene.endSec,
        ...(thumbKey ? { thumbUrl: await this.deps.storage.presignGet(thumbKey, { ttlSec }) } : {}),
      })),
    )
  }

  /** Hook candidates, best first, as the editor lists them. */
  async highlights(userId: string, projectId: string) {
    await requireReady(this.db, userId, projectId)
    const rows = await this.db
      .select()
      .from(highlights)
      .where(eq(highlights.projectId, projectId))
      .orderBy(sql`${highlights.hookScore} desc`, asc(highlights.startSec))
    return rows.map((h) => ({
      id: `hl_${h.idx}`,
      title: h.title,
      start: h.startSec,
      end: h.endSec,
      hookScore: h.hookScore,
      reason: h.reason,
      thumbSeed: h.thumbSeed,
    }))
  }

  async chapters(userId: string, projectId: string) {
    await requireReady(this.db, userId, projectId)
    const rows = await this.db
      .select()
      .from(chapters)
      .where(eq(chapters.projectId, projectId))
      .orderBy(asc(chapters.idx))
    return rows.map((c) => ({
      id: `ch_${c.idx}`,
      title: c.title,
      start: c.startSec,
      end: c.endSec,
    }))
  }

  /** A one-call overview of a project: what was found in it and where the edit stands. */
  async summary(userId: string, projectId: string) {
    const project = await requireProject(this.db, userId, projectId)
    const where = (t: { projectId: AnyPgColumn }) => eq(t.projectId, projectId)
    const [tr] = await this.db
      .select()
      .from(transcripts)
      .where(eq(transcripts.projectId, projectId))
    const [tl] = await this.db.select().from(timelines).where(eq(timelines.projectId, projectId))
    const assetRows = await this.db
      .select({ kind: assets.kind, n: count() })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.status, 'ready')))
      .groupBy(assets.kind)

    return {
      projectId,
      status: project.status,
      durationSec: project.durationSec ?? 0,
      language: project.sourceLanguage,
      counts: {
        words: tr?.wordCount ?? 0,
        sentences: await countOf(
          this.db
            .select({ n: count() })
            .from(transcriptSentences)
            .where(where(transcriptSentences)),
        ),
        scenes: await countOf(this.db.select({ n: count() }).from(scenes).where(where(scenes))),
        highlights: await countOf(
          this.db.select({ n: count() }).from(highlights).where(where(highlights)),
        ),
        chapters: await countOf(
          this.db.select({ n: count() }).from(chapters).where(where(chapters)),
        ),
        silences: await countOf(
          this.db.select({ n: count() }).from(silences).where(where(silences)),
        ),
        fillers: await countOf(
          this.db
            .select({ n: count() })
            .from(transcriptWords)
            .where(and(where(transcriptWords), eq(transcriptWords.filler, true))),
        ),
      },
      speakers: tr?.speakers ?? [],
      timeline: tl ? { version: tl.currentVersion, lastVersion: tl.lastVersion } : null,
      assets: Object.fromEntries(assetRows.map((r) => [r.kind, r.n])),
    }
  }

  /* ------------------------------- assets ------------------------------ */

  /**
   * The project's files, each with a link that expires and works for that one file. Video bytes never pass through
   * this server: the browser downloads straight from storage (or from the CDN once `CDN_BASE_URL` is set).
   */
  async assets(userId: string, projectId: string, kind?: (typeof assets.$inferSelect)['kind']) {
    await requireProject(this.db, userId, projectId)
    const rows = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, projectId), kind ? eq(assets.kind, kind) : undefined))
      .orderBy(asc(assets.createdAt), asc(assets.label))
    const ttlSec = this.deps.config.PRESIGN_GET_TTL_SEC
    const list = await Promise.all(
      rows.map(async (a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        status: a.status,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        durationSec: a.durationSec,
        width: a.width,
        height: a.height,
        sceneId: a.sceneId,
        ...(a.status === 'ready' ? { url: await this.urlFor(a, ttlSec) } : {}),
      })),
    )
    return { assets: list, expiresIn: ttlSec }
  }

  /** A fresh link for one file, for when a long editing session outlives the last one. */
  async assetUrl(userId: string, projectId: string, assetId: string) {
    await requireProject(this.db, userId, projectId)
    if (!UUID_RE.test(assetId)) throw err.notFound('File')
    const [asset] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId)))
    if (!asset) throw err.notFound('File')
    if (asset.status !== 'ready')
      throw new AppError(409, 'NOT_READY', 'That file is not ready yet.')
    const ttlSec = this.deps.config.PRESIGN_GET_TTL_SEC
    return { url: await this.urlFor(asset, ttlSec), expiresIn: ttlSec }
  }

  private urlFor(a: typeof assets.$inferSelect, ttlSec: number) {
    // The original and exports are downloads (named after what the person called them); the rest play in the page.
    const download = a.kind === 'raw' || a.kind === 'export'
    return this.deps.storage.presignGet(a.storageKey, {
      ttlSec,
      ...(download ? { filename: a.label } : {}),
      ...(a.mimeType ? { contentType: a.mimeType } : {}),
    })
  }
}
