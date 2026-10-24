import { readDataBlock } from '../llm/data-block.js'
import type { FakeHandler } from '../llm/index.js'
import { chapterTitle, reasonFor, titleFrom } from '../transcription/insights.js'
import { SCORE_HIGHLIGHTS, TITLE_CHAPTERS } from './tools.js'

/**
 * The offline model's rules for scoring moments and titling chapters. It reads the same data block a real model reads
 * and answers through the same tool, so the code around it cannot tell the difference. Scores come from the cheap
 * signals, with a small, stable nudge so equally-scored windows are not all identical.
 */
export const fakeHighlights: FakeHandler = (req) => {
  const data = readDataBlock<{
    candidates: Array<{
      id: string
      text: string
      signals: string[]
      fillerShare: number
      pace: number
    }>
  }>(req.context)
  const items = (data?.candidates ?? []).map((c) => ({
    id: c.id,
    title: titleFrom(c.text),
    hookScore: Math.max(
      0,
      Math.min(
        100,
        Math.round(40 + c.signals.length * 12 - c.fillerShare * 40 + Math.min(c.pace, 3) * 2),
      ),
    ),
    reason: reasonFor(new Set(c.signals) as never),
  }))
  return {
    text: '',
    toolCall: { id: 'fake-highlights', name: SCORE_HIGHLIGHTS.name, input: { items } },
  }
}

export const fakeChapters: FakeHandler = (req) => {
  const data = readDataBlock<{ chapters: Array<{ index: number; text: string }> }>(req.context)
  const items = (data?.chapters ?? []).map((c) => ({
    index: c.index,
    title: c.index === 0 ? 'Intro' : chapterTitle(c.text),
  }))
  return {
    text: '',
    toolCall: { id: 'fake-chapters', name: TITLE_CHAPTERS.name, input: { items } },
  }
}
