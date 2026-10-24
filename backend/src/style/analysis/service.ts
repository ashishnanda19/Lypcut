import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import {
  assets,
  reelAnalysis,
  reelMetrics,
  reels,
  styleProfiles,
  userPreferences,
} from '../../db/schema/index.js'
import type { Log } from '../../lib/log.js'
import { downloadTo, WorkDir } from '../../pipeline/workdir.js'
import { TranscriptionError, type TranscriptionProvider } from '../../transcription/types.js'
import { ALGO_VERSION } from './config.js'
import { engagementScores, watchPct, type ReelNumbers } from './engagement.js'
import { measureReel, jpegFrames, MeasureError, type ReelMeasurement } from './measure.js'
import { buildProfile, type DerivedProfile, type ReelFacts } from './profile.js'
import { factsKey, summaryFacts, writeSummary } from './summary.js'
import { selectWinners } from './winners.js'
import { labelCaptions, type CaptionLabel, type VisionInput } from './vision.js'

/** What is stored in `style_profiles.profile`: the derived numbers, plus the sentence and what it was written from. */
export interface StoredProfile extends DerivedProfile {
  summary?: string
  /** The figures the sentence was written from; the sentence is rewritten only when they change. */
  summaryKey?: string
}

export interface AnalysisResult {
  analysed: number
  /** Reels whose analysis was already stored for this file, so nothing was done. */
  cached: number
  failed: number
}

type ReelRow = typeof reels.$inferSelect

/** The numbers a person or Instagram gave for a Reel, folded from every reading, newest value of each winning. */
async function numbersByReel(
  db: AppDeps['database']['db'],
  reelIds: string[],
  durations: Map<string, number | null>,
  postedAt: Map<string, Date | null>,
): Promise<Map<string, { numbers: ReelNumbers; skipRate: number | null } | null>> {
  const out = new Map<string, { numbers: ReelNumbers; skipRate: number | null } | null>()
  if (!reelIds.length) return out
  const rows = await db
    .select()
    .from(reelMetrics)
    .where(inArray(reelMetrics.reelId, reelIds))
    .orderBy(desc(reelMetrics.readAt))
  const folded = new Map<string, Partial<Record<string, number>>>()
  for (const r of rows) {
    const cur = folded.get(r.reelId) ?? {}
    for (const k of [
      'views',
      'reach',
      'likes',
      'comments',
      'saves',
      'shares',
      'avgWatchSec',
      'avgWatchPct',
      'skipRate',
    ] as const) {
      const v = r[k]
      if (v !== null && cur[k] === undefined) cur[k] = v
    }
    folded.set(r.reelId, cur)
  }
  for (const id of reelIds) {
    const f = folded.get(id)
    if (!f) {
      out.set(id, null)
      continue
    }
    out.set(id, {
      numbers: {
        views: f.views ?? null,
        reach: f.reach ?? null,
        likes: f.likes ?? null,
        comments: f.comments ?? null,
        saves: f.saves ?? null,
        shares: f.shares ?? null,
        avgWatchPct: f.avgWatchPct ?? watchPct(f.avgWatchSec ?? null, durations.get(id) ?? null),
        postedAt: postedAt.get(id) ?? null,
      },
      skipRate: f.skipRate ?? null,
    })
  }
  return out
}

/**
 * Turns Reels into a style profile. The work is measuring (FFmpeg, speech recognition, arithmetic) with at most one model
 * call for the whole batch (to label captions the rules could not place) and one sentence at the end. It is safe to run
 * twice: a Reel whose file and algorithm version have been analysed is skipped, so a re-run only does what is new, and a run
 * that stopped halfway carries on from the Reels that are left.
 */
export class StyleAnalysis {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
    private readonly provider: TranscriptionProvider,
  ) {}

  private get db() {
    return this.deps.database.db
  }

  /**
   * Analyses the person's pending Reels (or the ones named). `onProgress` is told after each. Reels whose file cannot be
   * measured are marked failed with a reason; anything else (a service down) throws, so the job is retried.
   */
  async analyse(
    userId: string,
    opts: {
      reelIds?: string[]
      signal?: AbortSignal
      onProgress?: (done: number, total: number) => void
    } = {},
  ): Promise<AnalysisResult> {
    const rows = await this.db
      .select()
      .from(reels)
      .where(
        and(
          eq(reels.userId, userId),
          opts.reelIds
            ? inArray(reels.id, opts.reelIds)
            : inArray(reels.status, ['pending', 'analysing']),
        ),
      )
    const result: AnalysisResult = { analysed: 0, cached: 0, failed: 0 }
    const toLabel: VisionInput[] = []
    const pending: Array<{ reel: ReelRow; measured: ReelMeasurement; hash: string }> = []
    const [prefs] = await this.db
      .select({ language: userPreferences.language })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))

    const work = WorkDir.create(this.deps.config.TMP_DIR, `style-${randomUUID()}`)
    try {
      let done = 0
      for (const reel of rows) {
        opts.signal?.throwIfAborted()
        const outcome = await this.measureOne(
          reel,
          prefs?.language ?? 'hinglish',
          work,
          opts.signal,
        )
        if (outcome.kind === 'cached') result.cached++
        else if (outcome.kind === 'failed') result.failed++
        else {
          pending.push({ reel, measured: outcome.measured, hash: outcome.hash })
          if (outcome.frames.length) toLabel.push({ id: reel.id, frames: outcome.frames })
        }
        opts.onProgress?.(++done, rows.length)
      }
    } finally {
      work.destroy()
    }

    // One call for every Reel whose captions the rules could not place.
    const labels = toLabel.length
      ? await labelCaptions(this.deps.llm, toLabel, { userId }, this.log, {
          maxOutputTokens: this.deps.config.LLM_MAX_OUTPUT_TOKENS_BATCH,
          effort: this.deps.config.LLM_EFFORT_BATCH,
        })
      : new Map<string, CaptionLabel>()

    for (const p of pending) {
      await this.store(p.reel, p.measured, p.hash, labels.get(p.reel.id))
      result.analysed++
    }
    if (result.analysed || result.failed) await this.rebuildProfile(userId)
    return result
  }

  private async measureOne(
    reel: ReelRow,
    language: 'hi' | 'hinglish' | 'en',
    work: WorkDir,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'cached' }
    | { kind: 'failed' }
    | { kind: 'measured'; measured: ReelMeasurement; hash: string; frames: Buffer[] }
  > {
    const [asset] = reel.assetId
      ? await this.db.select().from(assets).where(eq(assets.id, reel.assetId))
      : []
    if (!asset) {
      // Nothing to measure (the file is gone, or this Reel came from Instagram's numbers alone).
      if (reel.source === 'upload') await this.fail(reel, 'no_video')
      return { kind: 'failed' }
    }

    // Cached by file and algorithm. When the upload recorded the file's hash and it is the one analysed, there is nothing to
    // do and the file need not even be fetched; otherwise it is fetched, hashed, and compared.
    if (
      asset.checksum &&
      asset.checksum === reel.contentHash &&
      (await this.hasAnalysis(reel.id, reel.contentHash))
    ) {
      await this.db
        .update(reels)
        .set({ status: 'analysed', failureCode: null })
        .where(eq(reels.id, reel.id))
      return { kind: 'cached' }
    }

    await this.db.update(reels).set({ status: 'analysing' }).where(eq(reels.id, reel.id))
    const file = work.file('reel.mp4')
    try {
      const hash = await downloadTo(this.deps.storage, asset.storageKey, file, signal)
      if (await this.hasAnalysis(reel.id, hash)) {
        await this.db
          .update(reels)
          .set({ status: 'analysed', contentHash: hash, failureCode: null })
          .where(eq(reels.id, reel.id))
        return { kind: 'cached' }
      }
      const measured = await measureReel(file, {
        provider: this.provider,
        language,
        work,
        ffprobeBin: this.deps.config.FFPROBE_BIN,
        sceneThreshold: this.deps.config.SCENE_THRESHOLD,
        signal,
      })
      const wantsLabel = measured.captions.status === 'ambiguous' && this.deps.llm.hasRealModel
      const frames = wantsLabel ? await jpegFrames(file, measured.frameTimes, work, { signal }) : []
      return { kind: 'measured', measured, hash, frames }
    } catch (e) {
      if (e instanceof MeasureError) {
        await this.fail(reel, e.code)
        return { kind: 'failed' }
      }
      if (e instanceof TranscriptionError && !e.retryable) {
        await this.fail(reel, 'transcription_failed')
        return { kind: 'failed' }
      }
      throw e
    } finally {
      work.remove('reel.mp4')
    }
  }

  private async hasAnalysis(reelId: string, hash: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: reelAnalysis.id })
      .from(reelAnalysis)
      .where(
        and(
          eq(reelAnalysis.reelId, reelId),
          eq(reelAnalysis.contentHash, hash),
          eq(reelAnalysis.algoVersion, ALGO_VERSION),
        ),
      )
    return !!row
  }

  private async fail(reel: ReelRow, code: string) {
    this.log.info({ reelId: reel.id, code }, 'a style reel could not be analysed')
    await this.db
      .update(reels)
      .set({ status: 'failed', failureCode: code })
      .where(eq(reels.id, reel.id))
  }

  private async store(
    reel: ReelRow,
    m: ReelMeasurement,
    hash: string,
    label: CaptionLabel | undefined,
  ) {
    let style: string | null
    let source: string
    if (m.captions.status === 'matched') {
      style = m.captions.styleId
      source = 'rules'
    } else if (m.captions.status === 'none') {
      style = null
      source = 'none'
    } else if (label) {
      style = label.style === 'none' ? null : label.style
      source = 'model'
    } else {
      // Captions are there but nothing placed them: say so, do not guess.
      style = 'custom'
      source = 'unmatched'
    }
    const font = label?.font ?? m.scriptFont
    const values = {
      reelId: reel.id,
      contentHash: hash,
      algoVersion: ALGO_VERSION,
      durationSec: m.durationSec,
      hookTimingSec: m.hookTimingSec,
      cutPace: m.cutPace,
      speechRateWpm: m.speechRateWpm,
      captionStyleId: style,
      captionStyleSource: source,
      fonts: style && font ? [font] : [],
      colors: style ? m.captions.colors : [],
      analysedAt: new Date(),
    }
    await this.db.transaction(async (tx) => {
      await tx
        .insert(reelAnalysis)
        .values(values)
        .onConflictDoUpdate({
          target: reelAnalysis.reelId,
          set: { ...values, engagementScore: null },
        })
      await tx
        .update(reels)
        .set({
          status: 'analysed',
          failureCode: null,
          contentHash: hash,
          durationSec: reel.durationSec ?? m.durationSec,
        })
        .where(eq(reels.id, reel.id))
    })
  }

  /**
   * Works the engagement scores out again, picks the winners, and writes the profile (and its sentence, if the figures
   * changed). Cheap: it reads stored rows only. Called after every analysis, and whenever a Reel is added, removed or
   * its numbers change.
   */
  async rebuildProfile(userId: string): Promise<StoredProfile | null> {
    const all = await this.db.select().from(reels).where(eq(reels.userId, userId))
    if (!all.length) {
      await this.db.delete(styleProfiles).where(eq(styleProfiles.userId, userId))
      return null
    }
    const analyses = await this.db
      .select()
      .from(reelAnalysis)
      .where(
        inArray(
          reelAnalysis.reelId,
          all.map((r) => r.id),
        ),
      )
    const analysisOf = new Map(analyses.map((a) => [a.reelId, a]))
    const nums = await numbersByReel(
      this.db,
      all.map((r) => r.id),
      new Map(all.map((r) => [r.id, r.durationSec ?? analysisOf.get(r.id)?.durationSec ?? null])),
      new Map(all.map((r) => [r.id, r.postedAt])),
    )

    const scores = engagementScores(
      all.map((r) => ({ id: r.id, numbers: nums.get(r.id)?.numbers ?? null })),
    )
    for (const a of analyses) {
      await this.db
        .update(reelAnalysis)
        .set({ engagementScore: scores.get(a.reelId)?.score ?? null })
        .where(eq(reelAnalysis.id, a.id))
    }

    // The profile is learned from Reels that were measured; a Reel known only by its numbers cannot say how it was cut.
    const facts: ReelFacts[] = all
      .filter((r) => analysisOf.has(r.id))
      .map((r) => {
        const a = analysisOf.get(r.id)!
        return {
          id: r.id,
          at: r.postedAt ?? r.createdAt,
          hookTimingSec: a.hookTimingSec,
          cutPace: a.cutPace,
          durationSec: a.durationSec,
          captionStyleId: a.captionStyleId,
          fonts: a.fonts,
          colors: a.colors,
          skipRate: nums.get(r.id)?.skipRate ?? null,
          hasMetrics: scores.get(r.id)?.score != null,
        }
      })
    if (!facts.length) {
      await this.db.delete(styleProfiles).where(eq(styleProfiles.userId, userId))
      return null
    }
    const selection = selectWinners(
      facts.map((f) => ({ id: f.id, score: scores.get(f.id)?.score ?? null })),
    )
    const derived = buildProfile(facts, selection)

    const [prefs] = await this.db
      .select({ language: userPreferences.language })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
    const [existing] = await this.db
      .select()
      .from(styleProfiles)
      .where(eq(styleProfiles.userId, userId))
    const before = existing?.profile as Partial<StoredProfile> | undefined
    const figures = summaryFacts(derived, prefs?.language ?? 'hinglish')
    const key = factsKey(figures)
    let summary = before?.summaryKey === key ? before.summary : undefined
    if (summary === undefined && before?.summaryKey !== key) {
      summary =
        (await writeSummary(
          this.deps.llm,
          figures,
          { userId },
          {
            maxOutputTokens: this.deps.config.LLM_MAX_OUTPUT_TOKENS_BATCH,
            effort: this.deps.config.LLM_EFFORT_BATCH,
          },
        )) ?? undefined
    }
    const profile: StoredProfile = { ...derived, ...(summary ? { summary, summaryKey: key } : {}) }
    await this.db
      .insert(styleProfiles)
      .values({
        userId,
        profile: profile as unknown as Record<string, unknown>,
        confidence: derived.confidence,
      })
      .onConflictDoUpdate({
        target: styleProfiles.userId,
        set: {
          profile: profile as unknown as Record<string, unknown>,
          confidence: derived.confidence,
          updatedAt: sql`now()`,
        },
      })
    return profile
  }
}
