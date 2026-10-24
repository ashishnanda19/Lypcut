import { asc, eq } from 'drizzle-orm'
import {
  cutFlags,
  removeFillersOp,
  timelineDuration,
  trimPausesOp,
  trackByKind,
  videoItems,
  type Timeline,
  type Word,
} from '@lypcut/timeline-core'
import type { AppDeps } from '../app/types.js'
import {
  chapters,
  highlights,
  transcriptSentences,
  transcripts,
  transcriptWords,
  styleProfiles,
  userPreferences,
} from '../db/schema/index.js'
import { dataBlock } from '../llm/data-block.js'
import { requireReady } from '../modules/content/service.js'
import { naturalText } from '../modules/search/semantic.js'
import { TimelineService } from '../modules/timeline/service.js'
import { CAPTION_STYLES } from './caption-styles.js'
import type {
  ChapterLite,
  HighlightLite,
  Lang,
  PlannerContext,
  RL,
  SentenceLite,
  StyleLite,
} from './types.js'

/** Everything about a project the assistant reads, loaded once per request. */
export interface ProjectData {
  projectId: string
  userId: string
  language: Lang
  timeline: Timeline
  /** The timeline version this was read at. A plan is checked against it. */
  version: number
  transcriptId: string
  words: Word[]
  sentences: SentenceLite[]
  highlights: HighlightLite[]
  chapters: ChapterLite[]
  /** The creator's learned style, if they have one. Whether the model sees it depends on the request. */
  style?: StyleLite
}

/** Words of a transcript do not change, so the last few loaded are kept: loading tens of thousands of rows is the slow part. */
class WordCache {
  private readonly map = new Map<string, Word[]>()
  constructor(private readonly max = 16) {}
  get(id: string) {
    const hit = this.map.get(id)
    if (hit) {
      this.map.delete(id)
      this.map.set(id, hit)
    }
    return hit
  }
  set(id: string, words: Word[]) {
    this.map.set(id, words)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
  }
}
const wordCache = new WordCache()

/**
 * Loads what the assistant needs. Every read starts from an ownership check (requireReady looks the project up by its
 * owner), and the cache is keyed by the transcript's own id, so nothing one person's request loaded can reach another.
 */
export async function loadProjectData(
  deps: AppDeps,
  userId: string,
  projectId: string,
): Promise<ProjectData> {
  const { db } = deps.database
  await requireReady(db, userId, projectId)
  const state = await new TimelineService(deps).getState(userId, projectId)

  const [tr] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(eq(transcripts.projectId, projectId))
  if (!tr) throw new Error('This project has no transcript.')
  const [user] = await db
    .select({ language: userPreferences.language })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))

  let words = wordCache.get(tr.id)
  if (!words) {
    const rows = await db
      .select({
        text: transcriptWords.text,
        dev: transcriptWords.dev,
        start: transcriptWords.startSec,
        end: transcriptWords.endSec,
        speaker: transcriptWords.speaker,
        language: transcriptWords.language,
        filler: transcriptWords.filler,
      })
      .from(transcriptWords)
      .where(eq(transcriptWords.transcriptId, tr.id))
      .orderBy(asc(transcriptWords.idx))
    words = rows.map((r) => ({ ...r, ...(r.filler ? { filler: true } : { filler: undefined }) }))
    wordCache.set(tr.id, words)
  }

  const [profile] = await db.select().from(styleProfiles).where(eq(styleProfiles.userId, userId))

  const sentenceRows = await db
    .select()
    .from(transcriptSentences)
    .where(eq(transcriptSentences.transcriptId, tr.id))
    .orderBy(asc(transcriptSentences.idx))
  const hl = await db
    .select()
    .from(highlights)
    .where(eq(highlights.projectId, projectId))
    .orderBy(asc(highlights.idx))
  const ch = await db
    .select()
    .from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(asc(chapters.idx))

  return {
    projectId,
    userId,
    language: user?.language ?? 'hinglish',
    timeline: state.timeline,
    version: state.version,
    transcriptId: tr.id,
    words,
    sentences: sentenceRows.map((s) => ({
      idx: s.idx,
      id: `s${s.idx}`,
      speaker: s.speaker,
      from: s.fromWord,
      to: s.toWord,
      start: s.startSec,
      end: s.endSec,
      text: naturalText(words.slice(s.fromWord, s.toWord)),
    })),
    highlights: hl.map((h) => ({
      id: `hl_${h.idx}`,
      title: h.title,
      start: h.startSec,
      end: h.endSec,
      hookScore: h.hookScore,
      reason: h.reason,
    })),
    ...(profile ? { style: toStyleLite(profile) } : {}),
    chapters: ch.map((c) => ({
      id: `ch_${c.idx}`,
      title: c.title,
      start: c.startSec,
      end: c.endSec,
    })),
  }
}

/** The profile row, cut down to what the assistant may use. Fields are read one by one, so nothing else can come along. */
export function toStyleLite(row: typeof styleProfiles.$inferSelect): StyleLite {
  const p = row.profile as Partial<{
    captionStyles: Array<{ id: string; share: number }>
    cutPace: number
    hookTimingSec: number
    summary: string
  }>
  return {
    connected: true,
    captionStyles: (p.captionStyles ?? []).map((c) => ({
      id: String(c.id),
      share: Number(c.share),
    })),
    cutPace: Number(p.cutPace ?? 0),
    hookTimingSec: Number(p.hookTimingSec ?? 0),
    confidence: row.confidence,
    ...(p.summary ? { summary: String(p.summary) } : {}),
  }
}

export function plannerContext(
  data: ProjectData,
  o: { playhead: number; applyStyle: boolean; planId: string; styleId?: string },
): PlannerContext {
  return {
    tl: data.timeline,
    tr: { words: data.words, sentences: data.sentences },
    highlights: data.highlights,
    chapters: data.chapters,
    lang: data.language,
    ...(data.style ? { style: data.style } : {}),
    applyStyle: o.applyStyle,
    playhead: o.playhead,
    planId: o.planId,
    ...(o.styleId ? { styleId: o.styleId } : {}),
  }
}

/** The source time under a timeline time (the video clip playing there), or null in a gap. */
export function sourceAt(tl: Timeline, t: number): number | null {
  const v = videoItems(tl).find((i) => t >= i.start && t < i.start + i.duration)
  return v ? Math.round((v.srcIn + (t - v.start)) * 10) / 10 : null
}

/** What fits the model's reading budget: the whole transcript if it can, shorter lines if not, the part near the playhead if still not. */
const SENTENCE_BUDGET_CHARS = 60_000

function sentenceLines(data: ProjectData, maxChars: number, around?: number) {
  let list = data.sentences
  if (around !== undefined) {
    // Keep the sentences nearest the playhead (in source time) that fit.
    const t = around
    list = [...list].sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))
  }
  const out: Array<{ id: string; speaker: string; start: number; end: number; text: string }> = []
  let used = 0
  for (const s of list) {
    const text = maxChars > 0 && s.text.length > maxChars ? `${s.text.slice(0, maxChars)}…` : s.text
    used += text.length + 40
    if (used > SENTENCE_BUDGET_CHARS && around !== undefined) break
    out.push({
      id: s.id,
      speaker: s.speaker,
      start: Math.round(s.start * 10) / 10,
      end: Math.round(s.end * 10) / 10,
      text,
    })
  }
  return around !== undefined ? out.sort((a, b) => a.start - b.start) : out
}

export interface DataBlockInput {
  data: ProjectData
  reply: RL
  playhead: number
  /** The creator's style, to show the model. Pass it only when the person has asked for their style to be applied. */
  style?: StyleLite | undefined
}

/**
 * The compact picture of a project the model reads, as one data block. Sentences carry ids, speaker and times, not every
 * word; highlights, chapters, the state of the edit, the playhead and the language come with them. Past a size limit the
 * lines are shortened, and for a very long video only the sentences around the playhead are included.
 */
export function buildDataBlock({ data, reply, playhead, style }: DataBlockInput): string {
  const tl = data.timeline
  const filler = removeFillersOp(tl, data.words)
  const pauses = trimPausesOp(tl, data.words)
  const flags = cutFlags(tl, data.words)
  const cutWords = flags.reduce((n, f) => n + f, 0)
  const src = sourceAt(tl, playhead)

  let lines = sentenceLines(data, 0)
  let truncated = false
  const size = () => lines.reduce((n, l) => n + l.text.length + 60, 0)
  if (size() > SENTENCE_BUDGET_CHARS) lines = sentenceLines(data, 90)
  if (size() > SENTENCE_BUDGET_CHARS) lines = sentenceLines(data, 50)
  if (size() > SENTENCE_BUDGET_CHARS) {
    lines = sentenceLines(data, 50, src ?? 0)
    truncated = true
  }

  const payload = {
    language: data.language,
    replyLanguage: reply,
    video: {
      sourceDurationSec: Math.round(tl.sourceDuration),
      editedDurationSec: Math.round(timelineDuration(tl) * 10) / 10,
      timelineVersion: data.version,
    },
    playhead: { timelineSec: Math.round(playhead * 10) / 10, sourceSec: src },
    edit: {
      videoClips: videoItems(tl).length,
      hasCaptions: Object.values(tl.items).some((i) => i.kind === 'caption'),
      captionStyleId: tl.settings.captionStyleId,
      captionsOn: tl.settings.captionsOn,
      captionTrack: !!trackByKind(tl, 'captions'),
      wordsAlreadyCut: cutWords,
      fillerWordsLeft: filler?.count ?? 0,
      longPausesLeft: pauses?.count ?? 0,
    },
    captionStyles: CAPTION_STYLES.map((s) => ({ id: s.id, name: s.name })),
    highlights: data.highlights.map((h) => ({
      id: h.id,
      title: h.title,
      start: Math.round(h.start),
      end: Math.round(h.end),
      hookScore: h.hookScore,
    })),
    chapters: data.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      start: Math.round(c.start),
      end: Math.round(c.end),
    })),
    sentences: lines,
    ...(truncated
      ? { note: 'Only the sentences around the playhead are listed: the video is long.' }
      : {}),
    // Only what the model needs to default sensibly: the usual look, how fast they cut, how soon they start, how sure we are.
    ...(style
      ? {
          myStyle: {
            captionStyles: style.captionStyles.slice(0, 3).map((c) => c.id),
            cutPaceCutsPer10Sec: style.cutPace,
            hookTimingSec: style.hookTimingSec,
            confidence: style.confidence,
            ...(style.summary ? { summary: style.summary } : {}),
          },
        }
      : {}),
  }
  return dataBlock(payload)
}
