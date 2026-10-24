/**
 * The real assistant: the same questions the stand-in planner answers (see planner.ts), asked of the backend. The answer
 * has the same shape, so the chat does not care which one replied.
 *
 * The server plans against the saved timeline, so every request waits for the edits still being saved first. Nothing
 * here throws at the person: a failure comes back as a short reply with no plan, in the chat, where they are looking.
 */
import { api, ApiError } from '@/api/client'
import type { ChatMessage, Lang, QuestionCard } from '@/types'
import { flushSaves } from './sync'
import type { PlannerResult } from './planner'

/** What the editor tells the assistant about where the person is. */
export interface AssistantContext {
  projectId: string
  playhead: number
  applyStyle: boolean
  messages: ChatMessage[]
  lang: Lang
}

/** How many earlier turns the assistant gets to read. The server accepts up to this many. */
const HISTORY_TURNS = 8
/** The longest message the server reads. */
const TEXT_CHARS = 1000
/** The server's limit on one earlier turn. */
const TURN_CHARS = 4000

const base = (projectId: string) => `/projects/${projectId}/assistant`

const common = (c: AssistantContext) => ({
  playhead: Math.max(0, Math.round(c.playhead * 100) / 100),
  applyStyle: c.applyStyle,
  history: c.messages
    .filter((m) => m.text.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => ({ from: m.from, text: m.text.slice(0, TURN_CHARS) })),
})

export async function askAssistant(c: AssistantContext, text: string): Promise<PlannerResult> {
  return run(c, () =>
    api.post<PlannerResult>(`${base(c.projectId)}/messages`, {
      ...common(c),
      text: text.slice(0, TEXT_CHARS),
    }),
  )
}

export async function answerAssistant(
  c: AssistantContext,
  question: QuestionCard,
  optionId: string,
): Promise<PlannerResult> {
  return run(c, () =>
    api.post<PlannerResult>(`${base(c.projectId)}/answers`, { ...common(c), question, optionId }),
  )
}

export async function reelAssistant(
  c: AssistantContext,
  range: { srcFrom: number; srcTo: number; title: string },
): Promise<PlannerResult> {
  return run(c, () =>
    api.post<PlannerResult>(`${base(c.projectId)}/reel`, { ...common(c), ...range, fast: true }),
  )
}

async function run(
  c: AssistantContext,
  call: () => Promise<PlannerResult>,
): Promise<PlannerResult> {
  try {
    await flushSaves()
    return await call()
  } catch (e) {
    return failure(e, c.lang)
  }
}

const say = (lang: Lang, s: { en: string; hinglish: string; hi: string }) => s[lang] ?? s.en

/** "Try again in 40 seconds" / "in 3 hours". */
function wait(sec: number, lang: Lang): string {
  if (sec < 90) {
    const n = Math.max(1, Math.round(sec))
    return say(lang, { en: `${n} seconds`, hinglish: `${n} second`, hi: `${n} सेकंड` })
  }
  if (sec < 5400) {
    const n = Math.round(sec / 60)
    return say(lang, { en: `${n} minutes`, hinglish: `${n} minute`, hi: `${n} मिनट` })
  }
  const n = Math.round(sec / 3600)
  return say(lang, { en: `${n} hours`, hinglish: `${n} ghante`, hi: `${n} घंटे` })
}

/** A failure as a chat reply: what happened and what to do, never a status code. */
export function failure(e: unknown, lang: Lang): PlannerResult {
  if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
    const retry = Number(e.details?.retryAfterSec)
    const when = Number.isFinite(retry) && retry > 0 ? wait(retry, lang) : undefined
    const perMinute = e.details?.window === 'minute'
    return {
      text: perMinute
        ? say(lang, {
            en: `That is a lot of requests at once. Try again in ${when ?? 'a moment'}.`,
            hinglish: `Ek saath bahut requests ho gayi. ${when ?? 'Thodi der'} baad try karo.`,
            hi: `एक साथ बहुत सारे अनुरोध हो गए। ${when ?? 'थोड़ी देर'} बाद कोशिश करें।`,
          })
        : say(lang, {
            en: `You have used today’s assistant requests. They come back in ${when ?? 'a few hours'}. Everything else in the editor still works.`,
            hinglish: `Aaj ki assistant requests khatam ho gayi. ${when ?? 'Kuch ghante'} mein wapas milengi. Editor ka baaki sab chalta rahega.`,
            hi: `आज के असिस्टेंट अनुरोध पूरे हो गए। ${when ?? 'कुछ घंटों'} में वापस मिलेंगे। एडिटर का बाकी सब चलता रहेगा।`,
          }),
    }
  }
  if (e instanceof ApiError && e.status === 401) return { text: e.message }
  return {
    text: say(lang, {
      en: 'I could not reach the assistant just now. Try again in a moment.',
      hinglish: 'Abhi assistant tak nahi pahunch paaya. Thodi der baad try karo.',
      hi: 'अभी असिस्टेंट तक नहीं पहुँच पाया। थोड़ी देर बाद कोशिश करें।',
    }),
  }
}
