import { z } from 'zod'
import type { Timeline, TimelineOp, Word } from '@lypcut/timeline-core'

/** The language a reply is written in. */
export type RL = 'en' | 'hinglish' | 'hi'
export type Lang = RL
export type Say = { en: string; hinglish: string; hi?: string }

export interface EditStripSegment {
  kind: 'keep' | 'cut' | 'add'
  weight: number
}

export interface SummaryChip {
  label: string
  value: string
  tone?: 'neutral' | 'saffron' | 'teal' | 'coral'
}

/** An Edit card before it is saved: everything except its id. */
export interface DraftPlan {
  title: string
  description: string
  op: TimelineOp
  strip: EditStripSegment[]
  summary: SummaryChip[]
  /** Timeline seconds the player should jump to when previewing. */
  focus?: number
}

export interface QuestionOption {
  id: string
  label: string
  hint?: string
}

export interface QuestionCard {
  id: string
  /** Where the answer goes next. For the Reel questions it follows a fixed grammar; see intent.ts. */
  intent: string
  prompt: string
  options: QuestionOption[]
  answer?: string
}

export type ChatTab = 'chat' | 'transcript' | 'search' | 'clips' | 'history'

/** What a builder returns. The plan becomes a saved plan (with an id) before it leaves the server. */
export interface BuiltResult {
  text: string
  plan?: DraftPlan
  question?: QuestionCard
  chips?: string[]
  open?: { tab: ChatTab; query?: string }
  route?: string
  action?: 'undo' | 'redo'
}

export interface SentenceLite {
  idx: number
  /** The editor's id for it: s0, s1, ... */
  id: string
  speaker: string
  from: number
  to: number
  start: number
  end: number
  text: string
}

export interface HighlightLite {
  id: string
  title: string
  start: number
  end: number
  hookScore: number
  reason: string
}

export interface ChapterLite {
  id: string
  title: string
  start: number
  end: number
}

/**
 * What the assistant knows about the creator's style: numbers and caption style ids, and one sentence. Never the handle, the
 * Reels, their numbers or anything from Instagram: nothing of the kind is in this type, so none can reach a prompt.
 */
export interface StyleLite {
  connected: boolean
  /** Editor caption style ids (or `custom`), biggest share first. */
  captionStyles: Array<{ id: string; share: number }>
  /** Cuts per 10 seconds. */
  cutPace: number
  /** Seconds to the first spoken word or strong picture change in the creator's best Reels. */
  hookTimingSec: number
  confidence: 'low' | 'medium' | 'high'
  summary?: string
}

/** Everything a builder needs to know about the project right now. */
export interface PlannerContext {
  tl: Timeline
  tr: { words: Word[]; sentences: SentenceLite[] }
  highlights: HighlightLite[]
  chapters: ChapterLite[]
  lang: Lang
  style?: StyleLite
  applyStyle: boolean
  /** Timeline time of the playhead. */
  playhead: number
  /** The id the plan will have, so anything the plan creates can be named after it. */
  planId: string
  /** A caption style the model chose, used for this plan. */
  styleId?: string
}

/* ---------------------- what the API sends the editor ---------------------- */

const op = z.custom<TimelineOp>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string',
)

export const questionCardSchema = z.object({
  id: z.string().min(1).max(100),
  intent: z.string().min(1).max(200),
  prompt: z.string().min(1).max(200),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        label: z.string().min(1).max(80),
        hint: z.string().max(160).optional(),
      }),
    )
    .min(1)
    .max(6),
  answer: z.string().max(60).optional(),
})

export const editPlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  op,
  strip: z.array(z.object({ kind: z.enum(['keep', 'cut', 'add']), weight: z.number() })),
  summary: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      tone: z.enum(['neutral', 'saffron', 'teal', 'coral']).optional(),
    }),
  ),
  focus: z.number().optional(),
})

/** The editor's PlannerResult (frontend/src/features/editor/planner.ts), field for field. */
export const plannerResultSchema = z.object({
  text: z.string(),
  plan: editPlanSchema.optional(),
  question: questionCardSchema.optional(),
  chips: z.array(z.string()).optional(),
  open: z
    .object({
      tab: z.enum(['chat', 'transcript', 'search', 'clips', 'history']),
      query: z.string().optional(),
    })
    .optional(),
  route: z.string().optional(),
  action: z.enum(['undo', 'redo']).optional(),
})
export type PlannerResult = z.infer<typeof plannerResultSchema>
