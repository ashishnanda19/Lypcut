import { createHash } from 'node:crypto'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { scenes, transcriptSentences, transcripts, transcriptWords } from '../db/schema/index.js'
import type { CandidateSentence } from './candidates.js'
import type { InsightWord } from '../transcription/insights.js'

/** Bump when the way highlights or chapters are found changes, so stored results are made again. */
export const INSIGHTS_VERSION = 'v1'

export interface InsightInput {
  transcriptId: string
  language: 'hi' | 'hinglish' | 'en'
  contentHash: string | null
  highlightsHash: string | null
  chaptersHash: string | null
  sentences: CandidateSentence[]
  words: InsightWord[]
  /** Source times where the picture cuts. */
  sceneCuts: number[]
}

/** The transcript, as the highlight and chapter steps read it. Null when the project has none. */
export async function loadInsightInput(
  db: Database['db'],
  projectId: string,
): Promise<InsightInput | null> {
  const [tr] = await db.select().from(transcripts).where(eq(transcripts.projectId, projectId))
  if (!tr) return null
  const rows = await db
    .select({
      from: transcriptSentences.fromWord,
      to: transcriptSentences.toWord,
      start: transcriptSentences.startSec,
      end: transcriptSentences.endSec,
      text: transcriptSentences.text,
      norm: transcriptSentences.norm,
      speaker: transcriptSentences.speaker,
    })
    .from(transcriptSentences)
    .where(eq(transcriptSentences.transcriptId, tr.id))
    .orderBy(asc(transcriptSentences.idx))
  const words = await db
    .select({ filler: transcriptWords.filler })
    .from(transcriptWords)
    .where(eq(transcriptWords.transcriptId, tr.id))
    .orderBy(asc(transcriptWords.idx))
  const cuts = await db
    .select({ start: scenes.startSec })
    .from(scenes)
    .where(and(eq(scenes.projectId, projectId), gt(scenes.idx, 0)))
  return {
    transcriptId: tr.id,
    language: tr.language,
    contentHash: tr.contentHash,
    highlightsHash: tr.highlightsHash,
    chaptersHash: tr.chaptersHash,
    sentences: rows,
    words,
    sceneCuts: cuts.map((c) => c.start),
  }
}

/** What stored highlights or chapters are keyed by: the transcript's content and the algorithm version. */
export const insightsKey = (contentHash: string | null, durationSec: number): string =>
  createHash('sha256')
    .update(`${contentHash ?? ''}|${INSIGHTS_VERSION}|${Math.round(durationSec)}`)
    .digest('hex')

/** A fingerprint of what was said and when: it changes only if the transcript does. */
export function contentHashOf(words: Array<{ text: string; start: number; end: number }>): string {
  const h = createHash('sha256')
  for (const w of words) h.update(`${w.text}|${w.start.toFixed(2)}|${w.end.toFixed(2)}\n`)
  return h.digest('hex')
}
