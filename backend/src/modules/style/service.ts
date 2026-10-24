import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import {
  assets,
  instagramAccounts,
  jobs,
  oauthStates,
  reelAnalysis,
  reelMetrics,
  reels,
  styleProfiles,
} from '../../db/schema/index.js'
import { activeUploads } from '../../lib/deletion.js'
import { err } from '../../lib/errors.js'
import { UUID_RE } from '../../lib/ids.js'
import type { Log } from '../../lib/log.js'
import { stylePrefix } from '../../lib/storage-keys.js'
import { enqueueJob } from '../../queue/enqueue.js'
import { numbersByReel, StyleAnalysis, type StoredProfile } from '../../style/analysis/service.js'
import type { TranscriptionProvider } from '../../transcription/types.js'
import type { ReelMetricDto, StyleProfileDto, StyleStatusDto } from './schema.js'

/** The API never transcribes; rebuilding a profile does not need it. */
const NO_TRANSCRIPTION: TranscriptionProvider = {
  name: 'none',
  model: null,
  diarizes: false,
  transcribe: () => Promise.reject(new Error('the API process does not transcribe')),
}

const FAILURES: Record<string, string> = {
  too_long: 'This Reel is longer than 90 seconds.',
  unreadable: 'We could not read this file as a video. Try exporting it again.',
  no_video: 'The file for this Reel is missing. Upload it again.',
  transcription_failed: 'We could not process the audio in this Reel.',
}

export const EMPTY_PROFILE: StyleProfileDto = {
  connected: false,
  source: null,
  reelsAnalysed: 0,
  hookTimingSec: 0,
  cutPace: 0,
  captionStyles: [],
  music: [],
  hookRetention: [],
  fonts: [],
  colors: [],
  confidence: 'low',
  updatedAt: null,
}

type ReelRow = typeof reels.$inferSelect

export class StyleService {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {}

  private get db() {
    return this.deps.database.db
  }

  private analysis() {
    return new StyleAnalysis(this.deps, this.log, NO_TRANSCRIPTION)
  }

  /* -------------------------------- profile ------------------------------- */

  /** Always a profile: an empty one, `connected: false`, when the person has none. */
  async profile(userId: string): Promise<StyleProfileDto> {
    const [[row], [account]] = await Promise.all([
      this.db.select().from(styleProfiles).where(eq(styleProfiles.userId, userId)),
      this.db.select().from(instagramAccounts).where(eq(instagramAccounts.userId, userId)),
    ])
    if (!row && !account) return EMPTY_PROFILE
    const p = (row?.profile ?? {}) as Partial<StoredProfile>
    return {
      ...EMPTY_PROFILE,
      connected: true,
      source: account ? 'instagram' : 'upload',
      ...(account ? { handle: account.handle } : {}),
      reelsAnalysed: p.reelsAnalysed ?? 0,
      hookTimingSec: p.hookTimingSec ?? 0,
      cutPace: p.cutPace ?? 0,
      captionStyles: p.captionStyles ?? [],
      music: [],
      hookRetention: p.hookRetention ?? [],
      fonts: p.fonts ?? [],
      colors: p.colors ?? [],
      confidence: row?.confidence ?? 'low',
      updatedAt: row?.updatedAt.toISOString() ?? null,
      ...(p.summary ? { summary: p.summary } : {}),
    }
  }

  /* --------------------------------- Reels -------------------------------- */

  /** The person's analysed Reels, best score first, Reels with no score after them, newest first. */
  async reels(userId: string): Promise<ReelMetricDto[]> {
    const rows = await this.db
      .select({ reel: reels, analysis: reelAnalysis, thumbKey: assets.storageKey })
      .from(reels)
      .leftJoin(reelAnalysis, eq(reelAnalysis.reelId, reels.id))
      .leftJoin(assets, eq(assets.id, reels.thumbnailAssetId))
      .where(and(eq(reels.userId, userId), eq(reels.status, 'analysed')))
    if (!rows.length) return []
    const nums = await numbersByReel(
      this.db,
      rows.map((r) => r.reel.id),
      new Map(rows.map((r) => [r.reel.id, r.reel.durationSec ?? r.analysis?.durationSec ?? null])),
      new Map(rows.map((r) => [r.reel.id, r.reel.postedAt])),
    )
    const ttlSec = this.deps.config.PRESIGN_GET_TTL_SEC
    const out = await Promise.all(
      rows.map(async ({ reel, analysis, thumbKey }): Promise<ReelMetricDto> => {
        const n = nums.get(reel.id)?.numbers
        return {
          id: reel.id,
          title: reel.label,
          thumbSeed: reel.id,
          ...(thumbKey
            ? { thumbUrl: await this.deps.storage.presignGet(thumbKey, { ttlSec }) }
            : {}),
          views: n?.views ?? null,
          likes: n?.likes ?? null,
          comments: n?.comments ?? null,
          saves: n?.saves ?? null,
          shares: n?.shares ?? null,
          avgWatchPct: n?.avgWatchPct == null ? null : Math.round(n.avgWatchPct * 10) / 10,
          durationSec: reel.durationSec ?? analysis?.durationSec ?? 0,
          postedAt: (reel.postedAt ?? reel.createdAt).toISOString(),
          engagement: analysis?.engagementScore ?? null,
          source: reel.source,
        }
      }),
    )
    return out.sort(
      (a, b) =>
        (b.engagement ?? -1) - (a.engagement ?? -1) ||
        b.postedAt.localeCompare(a.postedAt) ||
        a.id.localeCompare(b.id),
    )
  }

  /** Removes one Reel (its numbers, its picture and any video still held) and works the profile out again. */
  async deleteReel(userId: string, reelId: string): Promise<void> {
    if (!UUID_RE.test(reelId)) throw err.notFound('Reel')
    const [reel] = await this.db
      .select()
      .from(reels)
      .where(and(eq(reels.id, reelId), eq(reels.userId, userId)))
    if (!reel) throw err.notFound('Reel')
    const fileIds = [reel.assetId, reel.thumbnailAssetId].filter((x): x is string => !!x)
    const files = fileIds.length
      ? await this.db.select().from(assets).where(inArray(assets.id, fileIds))
      : []
    await this.db.delete(reels).where(eq(reels.id, reel.id))
    if (files.length)
      await this.db.delete(assets).where(
        inArray(
          assets.id,
          files.map((f) => f.id),
        ),
      )
    for (const f of files) await this.deps.storage.delete(f.storageKey).catch(() => undefined)
    await this.analysis().rebuildProfile(userId)
  }

  /* --------------------------------- status -------------------------------- */

  async status(userId: string): Promise<StyleStatusDto> {
    const rows = await this.db.select().from(reels).where(eq(reels.userId, userId))
    const [account] = await this.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.userId, userId))
    const [profile] = await this.db
      .select()
      .from(styleProfiles)
      .where(eq(styleProfiles.userId, userId))
    const recent = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          inArray(jobs.type, ['style_sync', 'style_analysis', 'style_refresh']),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(10)

    const count = (s: ReelRow['status']) => rows.filter((r) => r.status === s).length
    const reelsSummary = {
      total: rows.length,
      analysed: count('analysed'),
      analysing: count('analysing'),
      pending: count('pending'),
      failed: count('failed'),
    }
    const failed = rows
      .filter((r) => r.status === 'failed')
      .map((r) => ({
        id: r.id,
        label: r.label,
        code: r.failureCode ?? 'failed',
        message: FAILURES[r.failureCode ?? ''] ?? 'This Reel could not be analysed.',
      }))

    const active = recent.find((j) => j.status === 'queued' || j.status === 'running')
    const latest = recent[0]
    let state: StyleStatusDto['state']
    let progress = 0
    if (account?.status === 'reauth_required') state = 'reauth_required'
    else if (active) {
      state = active.type === 'style_analysis' ? 'analysing' : 'syncing'
      progress = active.progress
    } else if (reelsSummary.analysing > 0 || latest?.status === 'failed') state = 'failed'
    else if (profile) {
      state = 'ready'
      progress = 100
    } else state = 'idle'
    return {
      state,
      progress,
      reels: reelsSummary,
      failed,
      updatedAt: (profile?.updatedAt ?? latest?.updatedAt)?.toISOString() ?? null,
    }
  }

  /* ----------------------------- submitting uploads ----------------------------- */

  /**
   * Starts learning from the Reels the person has finished uploading. Their numbers, if they gave any, are stored with
   * each Reel; the analysis itself runs in the worker, and the page follows it with `status`.
   */
  async submit(
    userId: string,
    input: {
      count: number
      metrics?: Array<{
        reelId?: string
        fileName?: string
        views?: number
        likes?: number
        comments?: number
        saves?: number
        shares?: number
        avgWatchPct?: number
      }>
    },
  ): Promise<StyleProfileDto> {
    const job = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`style:${userId}`}::text))`)
      const waiting = await tx
        .select()
        .from(reels)
        .where(
          and(eq(reels.userId, userId), eq(reels.source, 'upload'), eq(reels.status, 'pending')),
        )
        .orderBy(asc(reels.createdAt))
      const ready = waiting.filter((r) => r.assetId)
      if (ready.length < input.count) {
        throw err.conflict(
          'CONFLICT',
          ready.length
            ? `Only ${ready.length} of ${input.count} Reels have finished uploading. Wait for the rest, then try again.`
            : 'No uploaded Reels are waiting. Upload your Reels first.',
          { uploaded: ready.length, expected: input.count },
        )
      }

      const byName = new Map<string, ReelRow[]>()
      for (const r of ready)
        byName.set(r.label.toLowerCase(), [...(byName.get(r.label.toLowerCase()) ?? []), r])
      const values: Array<typeof reelMetrics.$inferInsert> = []
      const seen = new Set<string>()
      for (const [i, m] of (input.metrics ?? []).entries()) {
        let target: ReelRow | undefined
        if (m.reelId) target = ready.find((r) => r.id === m.reelId)
        else {
          const stem = (m.fileName ?? '').replace(/\.[^./\\]+$/, '').toLowerCase()
          const matches = byName.get(stem) ?? byName.get((m.fileName ?? '').toLowerCase()) ?? []
          if (matches.length > 1)
            throw err.validation('Two Reels have that file name; use reelId instead.', {
              field: `metrics.${i}.fileName`,
            })
          target = matches[0]
        }
        if (!target)
          throw err.validation(
            'Those numbers are for a Reel that is not among your uploaded Reels.',
            {
              field: `metrics.${i}`,
            },
          )
        if (seen.has(target.id))
          throw err.validation('Numbers were given twice for the same Reel.', {
            field: `metrics.${i}`,
          })
        seen.add(target.id)
        const { reelId: _r, fileName: _f, ...numbers } = m
        if (Object.keys(numbers).length)
          values.push({ reelId: target.id, origin: 'upload', ...numbers })
      }
      if (values.length) await tx.insert(reelMetrics).values(values)

      await tx
        .update(reels)
        .set({ status: 'analysing', failureCode: null })
        .where(
          inArray(
            reels.id,
            ready.map((r) => r.id),
          ),
        )
      const [row] = await tx
        .insert(jobs)
        .values({
          userId,
          type: 'style_analysis',
          detail: 'Learning your style',
          payload: { reelIds: ready.map((r) => r.id) },
        })
        .returning()
      return row!
    })

    // If this add is lost, the worker's reconcile sweep re-enqueues the row.
    await enqueueJob(this.deps.queues, job).catch((e) =>
      this.log.error(
        { err: e, jobId: job.id },
        'could not enqueue style analysis; the sweep will retry',
      ),
    )
    return this.profile(userId)
  }

  /* ----------------------------- disconnecting ----------------------------- */

  /**
   * Removes everything Style holds for the person: the Instagram connection (and so its token), every Reel, its numbers and
   * analysis, the profile, pending sign-ins and the pictures and videos. The database rows are gone when this returns; the
   * files follow in a job that retries until storage is clean, and logs when it is.
   */
  async disconnect(userId: string): Promise<StyleProfileDto> {
    const uploads = await activeUploads(this.db, { userId, styleOnly: true })
    const job = await this.db.transaction(async (tx) => {
      await tx.delete(reels).where(eq(reels.userId, userId))
      await tx.delete(instagramAccounts).where(eq(instagramAccounts.userId, userId))
      await tx.delete(styleProfiles).where(eq(styleProfiles.userId, userId))
      await tx.delete(oauthStates).where(eq(oauthStates.userId, userId))
      // Style videos and pictures, and with them the upload records of any still in flight.
      await tx
        .delete(assets)
        .where(
          and(
            eq(assets.userId, userId),
            isNull(assets.projectId),
            inArray(assets.kind, ['style_reel', 'thumbnail']),
          ),
        )
      const [row] = await tx
        .insert(jobs)
        .values({
          userId,
          type: 'style_deletion',
          detail: 'Removing style data',
          payload: { prefix: stylePrefix(userId), uploads },
        })
        .returning()
      return row!
    })
    await enqueueJob(this.deps.queues, job).catch((e) =>
      this.log.error(
        { err: e, jobId: job.id },
        'could not enqueue style cleanup; the sweep will retry',
      ),
    )
    return EMPTY_PROFILE
  }

  /* -------------------------------- housekeeping -------------------------------- */

  /**
   * An uploaded Reel nobody submitted within a day is removed, with its video, so unsubmitted files do not sit in storage.
   */
  async sweepUnsubmitted(now = new Date(), olderThanMs = 24 * 3600_000): Promise<number> {
    const stale = await this.db
      .select()
      .from(reels)
      .where(
        and(
          eq(reels.source, 'upload'),
          eq(reels.status, 'pending'),
          lt(reels.createdAt, new Date(now.getTime() - olderThanMs)),
        ),
      )
      .limit(200)
    const analysis = this.analysis()
    for (const r of stale) {
      await analysis.disposeSource(r)
      await this.db.delete(reels).where(eq(reels.id, r.id))
    }
    return stale.length
  }
}
