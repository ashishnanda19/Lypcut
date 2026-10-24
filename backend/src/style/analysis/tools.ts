import { z } from 'zod'
import type { ToolDefinition } from '../../llm/index.js'
import { CAPTION_STYLE_IDS } from '../../planner/caption-styles.js'
import { EDITOR_FONTS } from './fonts.js'

export const labelCaptionsInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(40),
        style: z.enum([...CAPTION_STYLE_IDS, 'custom', 'none']),
        font: z.enum([...EDITOR_FONTS, 'unknown']),
      }),
    )
    .min(1)
    .max(12),
})

export const writeSummaryInput = z.strictObject({ sentence: z.string().min(10).max(240) })

export const LABEL_CAPTIONS: ToolDefinition = {
  name: 'label_captions',
  description: 'Give every video one caption look and one font family.',
  schema: labelCaptionsInput,
}

export const WRITE_SUMMARY: ToolDefinition = {
  name: 'write_summary',
  description: 'Give the one-sentence description of the creator’s style.',
  schema: writeSummaryInput,
}
