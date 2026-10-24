import { dataBlock } from '../../llm/data-block.js'
import { loadPrompt } from '../../llm/prompts.js'
import { LlmError, type Llm, type LlmBlock, type LlmContext } from '../../llm/index.js'
import type { Log } from '../../lib/log.js'
import { EDITOR_FONTS, type EditorFont } from './fonts.js'
import { LABEL_CAPTIONS, labelCaptionsInput } from './tools.js'

/** What the model said about one Reel's captions, already checked against the closed lists. */
export interface CaptionLabel {
  /** An editor caption style id, `custom`, or `none`. */
  style: string
  font: EditorFont | null
}

export interface VisionInput {
  id: string
  /** JPEGs of a few frames. */
  frames: Buffer[]
}

/** The most Reels one call carries, and frames per Reel: bounds what a sync can cost. */
export const MAX_REELS_PER_CALL = 12
export const MAX_FRAMES_PER_REEL = 4

/**
 * One call for all the Reels whose captions the rules could not place. The model sees a few frames of each and answers
 * from closed lists (the editor's looks and fonts), so whatever it says is one of those or it is dropped: it cannot invent
 * a style, and nothing it is shown can change what is done with its answer. Any failure gives an empty result, and the
 * Reels are recorded as `custom`: the profile is still built.
 */
export async function labelCaptions(
  llm: Llm,
  reels: VisionInput[],
  ctx: LlmContext,
  log: Log,
  opts: { maxOutputTokens: number; effort: 'low' | 'medium' | 'high' },
): Promise<Map<string, CaptionLabel>> {
  const out = new Map<string, CaptionLabel>()
  const batch = reels.filter((r) => r.frames.length).slice(0, MAX_REELS_PER_CALL)
  if (!batch.length) return out
  const ids = new Set(batch.map((r) => r.id))

  const content: LlmBlock[] = [{ type: 'text', text: 'Label the captions of every video below.' }]
  for (const r of batch) {
    content.push({ type: 'text', text: `Video ${r.id}:` })
    for (const f of r.frames.slice(0, MAX_FRAMES_PER_REEL))
      content.push({ type: 'image', mediaType: 'image/jpeg', data: f.toString('base64') })
  }

  try {
    const reply = await llm.generate(
      {
        purpose: 'style',
        system: loadPrompt('style-captions.v1'),
        context: dataBlock({
          videos: batch.map((r) => ({
            id: r.id,
            frames: Math.min(r.frames.length, MAX_FRAMES_PER_REEL),
          })),
        }),
        messages: [{ role: 'user', content }],
        tools: [LABEL_CAPTIONS],
        maxOutputTokens: opts.maxOutputTokens,
        effort: opts.effort,
      },
      ctx,
    )
    if (!reply.toolCall || reply.toolCall.name !== LABEL_CAPTIONS.name || reply.extraToolCalls > 0)
      return out
    const parsed = labelCaptionsInput.safeParse(reply.toolCall.input)
    if (!parsed.success) {
      log.warn({ projectId: ctx.projectId }, 'caption labels did not parse; using custom')
      return out
    }
    for (const item of parsed.data.items) {
      if (!ids.has(item.id) || out.has(item.id)) continue
      out.set(item.id, {
        style: item.style,
        font: (EDITOR_FONTS as readonly string[]).includes(item.font)
          ? (item.font as EditorFont)
          : null,
      })
    }
  } catch (e) {
    if (!(e instanceof LlmError)) throw e
    log.warn({ error: e.kind }, 'caption labelling failed; using custom')
  }
  return out
}
