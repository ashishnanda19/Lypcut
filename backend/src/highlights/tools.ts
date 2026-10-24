import { z } from 'zod'
import type { ToolDefinition } from '../llm/index.js'

export const scoreHighlightsInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(20),
        title: z.string().min(1).max(200),
        hookScore: z.number().min(0).max(100),
        reason: z.string().min(1).max(400),
      }),
    )
    .min(1)
    .max(60),
})

export const titleChaptersInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(50),
        title: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(20),
})

export const SCORE_HIGHLIGHTS: ToolDefinition = {
  name: 'score_highlights',
  description: 'Give every candidate a title, a hook score from 0 to 100 and a one-line reason.',
  schema: scoreHighlightsInput,
}

export const TITLE_CHAPTERS: ToolDefinition = {
  name: 'title_chapters',
  description: 'Give every chapter a short title.',
  schema: titleChaptersInput,
}
