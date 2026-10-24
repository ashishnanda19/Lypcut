import { z } from 'zod'
import type { ToolDefinition } from '../llm/index.js'
import { CAPTION_STYLE_IDS } from './caption-styles.js'

/**
 * Everything the assistant can do, and nothing else: this list is the whole attack surface. Each tool takes only what the
 * model can know (a sentence id, a highlight id, a style, a number); where in the video, and the op itself, are worked
 * out by code. Every argument is checked with a strict schema (an unknown field is an error) before anything is looked up.
 */
const ID = z.string().min(1).max(40)
const SENTENCE_ID = z.string().regex(/^s\d{1,6}$/, 'a sentence id like s12')
const none = z.strictObject({})
/** True when the person asked for their own style ("in my style"), which applies it even if the toggle is off. */
const useMyStyle = z.boolean().optional()

export const toolSchemas = {
  remove_fillers: none,
  trim_pauses: z.strictObject({ maxPauseSec: z.number().min(0.3).max(3).optional() }),
  add_captions: z.strictObject({ styleId: z.enum(CAPTION_STYLE_IDS).optional(), useMyStyle }),
  set_caption_style: z.strictObject({
    styleId: z.enum(CAPTION_STYLE_IDS).optional(),
    useMyStyle,
  }),
  match_my_style: none,
  make_reel: z.strictObject({
    source: z
      .strictObject({
        kind: z.enum(['highlight', 'chapter', 'search', 'playhead', 'whole']),
        id: ID.optional(),
        query: z.string().min(2).max(200).optional(),
      })
      .optional(),
    lengthSec: z.number().int().min(5).max(180).optional(),
    pace: z.enum(['fast', 'calm']).optional(),
    useMyStyle,
  }),
  find_moment: z.strictObject({ query: z.string().min(2).max(200) }),
  best_hooks: none,
  cut_range: z.strictObject({ firstSentence: SENTENCE_ID, lastSentence: SENTENCE_ID }),
  trim_intro: none,
  add_effect: z.strictObject({
    effect: z.enum(['blur', 'zoom']),
    lengthSec: z.number().min(1).max(10).optional(),
  }),
  ask_question: z.strictObject({
    prompt: z.string().min(2).max(160),
    options: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9_-]{1,30}$/, 'a short lowercase id'),
          label: z.string().min(1).max(40),
          hint: z.string().max(80).optional(),
        }),
      )
      .min(2)
      .max(4),
  }),
  undo: none,
  redo: none,
} as const

export type ToolName = keyof typeof toolSchemas
export type ToolInput<N extends ToolName> = z.infer<(typeof toolSchemas)[N]>

const DESCRIPTIONS: Record<ToolName, string> = {
  remove_fillers: 'Cut the filler words (um, matlab, basically ...) that are still in the edit.',
  trim_pauses:
    'Shorten the long pauses to a natural beat. maxPauseSec: pauses longer than this are shortened (default 0.7).',
  add_captions:
    'Add captions to the edit, optionally in a given caption style. Set useMyStyle when the person asks for captions in their own style.',
  set_caption_style:
    'Change the look of the captions to one of the caption styles. Give no styleId, and set useMyStyle, when the person asks for their own caption look.',
  match_my_style:
    'Edit the way this creator edits: a Reel from the part that opens like their best Reels, pauses tightened to how often they cut, captions in their usual look. Takes no arguments. Use it when they ask to match, apply or use their style.',
  make_reel:
    'Build a short vertical Reel. Give only what the person said: leave out source, lengthSec or pace if they did not say it (the person will be asked). Set useMyStyle when they ask for it in their own style. source: a highlight (id from highlights), a chapter (id from chapters), a search (query), the playhead, or the whole video.',
  find_moment:
    'Find where the person talks about something, by what was said. Shows the moments in the Search tab.',
  best_hooks: 'Show the strongest hooks (highlights) and build a Reel from the best one.',
  cut_range:
    'Cut out a stretch of speech, from the first sentence to the last (sentence ids from sentences, inclusive).',
  trim_intro: 'Cut the opening line, so the video starts on the second sentence.',
  add_effect: 'Add a blur or a zoom (punch-in) at the playhead for a few seconds.',
  ask_question:
    'Ask the person to choose between 2 to 4 options when the request could mean different things. Use it sparingly.',
  undo: 'Undo the last change.',
  redo: 'Redo the change that was just undone.',
}

export const TOOLS: ToolDefinition[] = (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  schema: toolSchemas[name],
}))

export const isToolName = (n: string): n is ToolName =>
  Object.prototype.hasOwnProperty.call(toolSchemas, n)

export type ParsedCall = { [N in ToolName]: { name: N; input: ToolInput<N> } }[ToolName]

/** Checks a tool call from the model: a known tool, and arguments that fit its schema exactly. */
export function parseToolCall(
  name: string,
  input: unknown,
): { ok: true; call: ParsedCall } | { ok: false; error: string } {
  if (!isToolName(name))
    return {
      ok: false,
      error: `There is no tool called "${name.slice(0, 40)}". Use one of: ${Object.keys(toolSchemas).join(', ')}.`,
    }
  const parsed = toolSchemas[name].safeParse(input ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `The arguments for ${name} are not valid: ${issues}`.slice(0, 500) }
  }
  return { ok: true, call: { name, input: parsed.data } as ParsedCall }
}
