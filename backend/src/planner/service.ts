import { randomUUID } from 'node:crypto'
import { applyOp, OpError, type TimelineOp } from '@lypcut/timeline-core'
import type { AppDeps } from '../app/types.js'
import { LlmError, type LlmMessage } from '../llm/index.js'
import { loadPrompt } from '../llm/prompts.js'
import { err } from '../lib/errors.js'
import type { Log } from '../lib/log.js'
import { uuidv7 } from '../lib/ids.js'
import { SearchService } from '../modules/search/service.js'
import {
  askLength,
  askPart,
  askStyle,
  bestHooks,
  captionsPlan,
  captionStylePlan,
  cutRangePlan,
  effectPlan,
  fillersPlan,
  finishReel,
  matchMyStylePlan,
  noStyleYet,
  pausesPlan,
  profileStyleId,
  reelPlan,
  trimIntro,
  windowFor,
} from './builders.js'
import { buildDataBlock, loadProjectData, plannerContext, type ProjectData } from './context.js'
import { parseReelIntent, validAnswer } from './intent.js'
import {
  asksForMusic,
  cleanPrompt,
  failedReply,
  HELP_CHIPS,
  cannotYet,
  musicReply,
  replyLang,
  say,
} from './language.js'
import { savePlan, toEditPlan } from './store.js'
import { parseToolCall, TOOLS, type ParsedCall } from './tools.js'
import type { BuiltResult, PlannerContext, PlannerResult, QuestionCard, RL } from './types.js'

export interface Turn {
  from: 'user' | 'ai'
  text: string
}

export interface CommonInput {
  playhead: number
  applyStyle: boolean
  /** The last few turns of the conversation, oldest first. */
  history: Turn[]
}

export interface MessageInput extends CommonInput {
  text: string
}

export interface AnswerInput extends CommonInput {
  question: QuestionCard
  optionId: string
}

export interface ReelInput extends CommonInput {
  srcFrom: number
  srcTo: number
  title: string
  fast: boolean
  hookScore?: number
}

/** How many times the model may be told what was wrong with its answer. */
const MAX_REPAIRS = 2
const MAX_HISTORY = 8
const MAX_TURN_CHARS = 600

/** Ops the assistant may propose. `patch` is the engine's own language for inverses; `restoreSource` is for undo. */
const FORBIDDEN_OPS = new Set(['patch', 'restoreSource'])
function forbiddenOp(op: TimelineOp): string | null {
  if (FORBIDDEN_OPS.has(op.type)) return op.type
  if (op.type === 'batch')
    for (const o of op.ops) {
      const bad = forbiddenOp(o)
      if (bad) return bad
    }
  return null
}

type Executed = { error: string } | { result: BuiltResult }

/**
 * Turns a chat message into a saved plan. The model chooses what to do and names things by id; this code works out where,
 * builds the op, checks it with the same engine the editor uses (a dry run on a copy of the timeline), tells the model what
 * was wrong if the check fails (twice at most), and only then saves the plan. A plan that fails the check is never
 * returned, and nothing the model wrote reaches the database except as an op that passed.
 */
export class PlannerService {
  private readonly search: SearchService

  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {
    this.search = new SearchService(deps, log)
  }

  /* ------------------------------ entry points ------------------------------ */

  async message(userId: string, projectId: string, input: MessageInput): Promise<PlannerResult> {
    const data = await loadProjectData(this.deps, userId, projectId)
    const text = cleanPrompt(input.text)
    const rl = replyLang(text, data.language)
    if (!text) {
      return {
        text: say(rl, { en: 'Tell me what to do.', hinglish: 'Batao kya karna hai.' }),
        chips: HELP_CHIPS,
      }
    }
    // Asking for music has one answer, and needs no model.
    if (asksForMusic(text)) return { text: musicReply(rl), chips: HELP_CHIPS }
    return this.converse(data, rl, text, input)
  }

  async answer(userId: string, projectId: string, input: AnswerInput): Promise<PlannerResult> {
    const data = await loadProjectData(this.deps, userId, projectId)
    const card = input.question
    const option = card.options.find((o) => o.id === input.optionId)
    if (!option) throw err.validation('That is not one of the options.', { field: 'optionId' })

    if (card.intent === 'ask') {
      // A question the assistant asked itself: the answer goes back to it as the person's next words.
      const history = [...input.history, { from: 'ai' as const, text: card.prompt }]
      const rl = replyLang(option.label, data.language)
      return this.converse(data, rl, cleanPrompt(option.label), { ...input, history })
    }

    const intent = parseReelIntent(card.intent)
    if (!intent)
      throw err.validation('That answer does not belong to a question I asked.', {
        field: 'intent',
      })
    if (!validAnswer(intent.step, input.optionId))
      throw err.validation('That is not an option for this question.', { field: 'optionId' })

    const rl = data.language
    const planId = uuidv7()
    const ctx = plannerContext(data, {
      playhead: input.playhead,
      applyStyle: input.applyStyle,
      planId,
    })
    let built: BuiltResult
    if (intent.step === 'part') {
      if (input.optionId === 'all' && !intent.len) built = askLength(rl, 'all', intent.style)
      else if (!intent.len) built = askLength(rl, input.optionId, intent.style)
      else if (!intent.style) built = askStyle(rl, input.optionId, intent.len)
      else built = finishReel(ctx, rl, input.optionId, intent.len, intent.style)
    } else if (intent.step === 'len') {
      built = !intent.style
        ? askStyle(rl, intent.part ?? 'best', input.optionId)
        : finishReel(ctx, rl, intent.part ?? 'best', input.optionId, intent.style)
    } else {
      built = finishReel(ctx, rl, intent.part ?? 'best', intent.len, input.optionId)
    }
    return this.finish(data, ctx, rl, built)
  }

  async reel(userId: string, projectId: string, input: ReelInput): Promise<PlannerResult> {
    const data = await loadProjectData(this.deps, userId, projectId)
    const duration = data.timeline.sourceDuration
    if (!(input.srcFrom >= 0 && input.srcTo > input.srcFrom && input.srcTo <= duration + 0.5)) {
      throw err.validation('Pick a range inside the video.', { field: 'srcFrom' })
    }
    const rl = data.language
    const planId = uuidv7()
    const ctx = plannerContext(data, {
      playhead: input.playhead,
      applyStyle: input.applyStyle,
      planId,
    })
    const built = reelPlan(
      ctx,
      {
        srcFrom: input.srcFrom,
        srcTo: Math.min(input.srcTo, duration),
        title: cleanPrompt(input.title).slice(0, 80) || 'Reel',
        fast: input.fast,
        hookScore: input.hookScore,
      },
      rl,
    )
    return this.finish(data, ctx, rl, built)
  }

  /* --------------------------- the model's turn(s) --------------------------- */

  private async converse(
    data: ProjectData,
    rl: RL,
    userText: string,
    input: CommonInput,
  ): Promise<PlannerResult> {
    const { config, llm } = this.deps
    const planId = uuidv7()
    const requestId = uuidv7()
    const ctx = plannerContext(data, {
      playhead: input.playhead,
      applyStyle: input.applyStyle,
      planId,
    })
    const system = loadPrompt('planner.v2')
    // The creator's style goes to the model only when they have turned it on and there is a profile to show.
    const context = buildDataBlock({
      data,
      reply: rl,
      playhead: input.playhead,
      style: input.applyStyle ? data.style : undefined,
    })
    const messages = conversation(input.history, userText)

    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      let reply
      try {
        reply = await llm.generate(
          {
            purpose: 'planner',
            system,
            context,
            messages,
            tools: TOOLS,
            maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS_PLANNER,
            effort: config.LLM_EFFORT_PLANNER,
          },
          { userId: data.userId, projectId: data.projectId, requestId },
        )
      } catch (e) {
        const slow =
          e instanceof LlmError &&
          (e.kind === 'timeout' || e.kind === 'rate_limited' || e.kind === 'overloaded')
        return { text: failedReply(rl, slow ? 'slow' : 'could_not'), chips: HELP_CHIPS }
      }

      // The model declined, or ran out of room: say so, with no plan.
      if (reply.stop === 'refusal') return { text: cannotYet(rl), chips: HELP_CHIPS }
      if (reply.stop === 'max_tokens')
        return { text: failedReply(rl, 'could_not'), chips: HELP_CHIPS }

      if (!reply.toolCall) {
        const said = reply.text.replace(/\s+/g, ' ').trim().slice(0, 800)
        return { text: said || cannotYet(rl), chips: HELP_CHIPS }
      }

      let problem: string | null = null
      if (reply.extraToolCalls > 0) problem = 'Call exactly one tool.'
      else {
        const parsed = parseToolCall(reply.toolCall.name, reply.toolCall.input)
        if (!parsed.ok) problem = parsed.error
        else {
          const done = await this.execute(parsed.call, ctx, data, rl)
          if ('result' in done) {
            const checked = this.check(done.result, ctx)
            if (checked === null) return this.finish(data, ctx, rl, done.result)
            problem = checked
          } else problem = done.error
        }
      }

      this.log.info(
        { projectId: data.projectId, attempt, tool: reply.toolCall.name, repaired: attempt > 0 },
        'planner call needs a correction',
      )
      messages.push(
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: reply.toolCall.id,
              name: reply.toolCall.name,
              input: reply.toolCall.input,
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', id: reply.toolCall.id, content: problem, isError: true },
          ],
        },
      )
    }
    return { text: failedReply(rl, 'could_not'), chips: HELP_CHIPS }
  }

  /* ------------------------------ the tools ------------------------------ */

  private async execute(
    call: ParsedCall,
    ctx: PlannerContext,
    data: ProjectData,
    rl: RL,
  ): Promise<Executed> {
    switch (call.name) {
      case 'remove_fillers':
        return { result: fillersPlan(ctx, rl) }
      case 'trim_pauses':
        return { result: pausesPlan(ctx, rl, call.input.maxPauseSec) }
      case 'add_captions':
        return {
          result: captionsPlan(
            {
              ...ctx,
              applyStyle: ctx.applyStyle || !!call.input.useMyStyle,
              styleId: call.input.styleId,
            },
            rl,
          ),
        }
      case 'set_caption_style': {
        // Their own look, when they asked for it and it has one the editor can apply; otherwise the look the model named.
        const mine = ctx.applyStyle || call.input.useMyStyle ? profileStyleId(ctx.style) : null
        const id = call.input.styleId ?? mine
        if (!id) {
          return {
            result: ctx.style
              ? {
                  text: say(rl, {
                    en: 'Your own caption look is not one I can apply yet. Tell me which of the caption styles you want.',
                    hinglish:
                      'Aapka apna caption look abhi main laga nahi sakta. Batao kaunsi caption style chahiye.',
                    hi: 'आपका अपना कैप्शन लुक मैं अभी नहीं लगा सकता। बताइए कौन सी कैप्शन स्टाइल चाहिए।',
                  }),
                  route: '/app/style',
                }
              : noStyleYet(rl),
          }
        }
        return { result: captionStylePlan(ctx, id, rl, !call.input.styleId && id === mine) }
      }
      case 'match_my_style':
        return { result: matchMyStylePlan(ctx, rl) }
      case 'trim_intro':
        return { result: trimIntro(ctx, rl) }
      case 'best_hooks':
        return { result: bestHooks(ctx, rl) }
      case 'add_effect':
        return { result: effectPlan(ctx, call.input.effect, rl, call.input.lengthSec) }
      case 'undo':
        return {
          result: {
            text: say(rl, {
              en: 'Undone. You can redo it with Shift plus Cmd or Ctrl plus Z.',
              hinglish: 'Undo kar diya. Redo ke liye Shift + Cmd/Ctrl + Z dabao.',
              hi: 'अनडू कर दिया।',
            }),
            action: 'undo',
          },
        }
      case 'redo':
        return {
          result: {
            text: say(rl, { en: 'Redone.', hinglish: 'Redo kar diya.', hi: 'रीडू कर दिया।' }),
            action: 'redo',
          },
        }
      case 'cut_range': {
        const byId = new Map(ctx.tr.sentences.map((s) => [s.id, s]))
        const first = byId.get(call.input.firstSentence)
        const last = byId.get(call.input.lastSentence)
        const max = ctx.tr.sentences.length - 1
        if (!first)
          return {
            error: `There is no sentence ${call.input.firstSentence}. Sentence ids run from s0 to s${max}.`,
          }
        if (!last)
          return {
            error: `There is no sentence ${call.input.lastSentence}. Sentence ids run from s0 to s${max}.`,
          }
        if (last.idx < first.idx)
          return { error: 'lastSentence must not come before firstSentence.' }
        return { result: cutRangePlan(ctx, first, last, rl) }
      }
      case 'ask_question': {
        const ids = new Set(call.input.options.map((o) => o.id))
        if (ids.size !== call.input.options.length)
          return { error: 'The options need different ids.' }
        return {
          result: {
            text: call.input.prompt,
            question: {
              id: `q_${randomUUID().slice(0, 8)}`,
              intent: 'ask',
              prompt: call.input.prompt,
              options: call.input.options,
            },
          },
        }
      }
      case 'find_moment':
        return { result: await this.findMoment(ctx, data, call.input.query, rl) }
      case 'make_reel':
        return this.makeReel(
          { ...ctx, applyStyle: ctx.applyStyle || !!call.input.useMyStyle },
          data,
          call.input,
          rl,
        )
    }
  }

  private async findMoment(
    ctx: PlannerContext,
    data: ProjectData,
    query: string,
    rl: RL,
  ): Promise<BuiltResult> {
    const hits = await this.search.search(data.userId, data.projectId, query, 3)
    if (!hits.length) {
      return {
        text: say(rl, {
          en: `I could not find “${query}”. Try a different word, or ask in Hindi.`,
          hinglish: `“${query}” nahi mila. Doosra word try karo, ya Hindi mein poochho.`,
          hi: `“${query}” नहीं मिला। कोई दूसरा शब्द आज़माएं।`,
        }),
        open: { tab: 'search', query },
      }
    }
    const top = hits[0]!
    const secs = (n: number) =>
      `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`
    const reel = reelPlan(ctx, { srcFrom: top.start, srcTo: top.end, title: query, fast: true }, rl)
    return {
      ...reel,
      text: say(rl, {
        en: `Found ${hits.length} place${hits.length > 1 ? 's' : ''} where you talk about “${query}”. The best one is at ${secs(top.start)}. Here is a Reel from it, and the Search tab has the rest.`,
        hinglish: `${hits.length} jagah mili jahan aap “${query}” ke baare mein bol rahe ho. Sabse achhi ${secs(top.start)} par hai. Usse Reel ye rahi, baaki Search tab mein hain.`,
        hi: `“${query}” के बारे में ${hits.length} जगह मिलीं। सबसे अच्छी ${secs(top.start)} पर है।`,
      }),
      open: { tab: 'search', query },
    }
  }

  private async makeReel(
    ctx: PlannerContext,
    data: ProjectData,
    input: {
      source?: { kind: string; id?: string; query?: string }
      lengthSec?: number
      pace?: 'fast' | 'calm'
    },
    rl: RL,
  ): Promise<Executed> {
    const len = input.lengthSec !== undefined ? String(input.lengthSec) : undefined
    const style = input.pace
    const src = input.source
    if (!src) return { result: askPart(ctx, rl, len, style) }

    // The generic parts go through the same questions as the Reel buttons: how long, then what pace.
    const best = [...data.highlights].sort((a, b) => b.hookScore - a.hookScore)[0]
    const generic =
      src.kind === 'whole'
        ? 'all'
        : src.kind === 'playhead'
          ? 'here'
          : src.kind === 'highlight' && src.id === best?.id
            ? 'best'
            : null
    if (generic) {
      if (!len) return { result: askLength(rl, generic, style) }
      if (!style) return { result: askStyle(rl, generic, len) }
      return { result: finishReel(ctx, rl, generic, len, style) }
    }

    // A specific highlight, chapter or search hit is a range already; only its length may be trimmed.
    let range: { from: number; to: number; title: string; hookScore?: number } | undefined
    if (src.kind === 'highlight') {
      const h = data.highlights.find((x) => x.id === src.id)
      if (!h)
        return {
          error: `There is no highlight ${src.id ?? '(none given)'}. Highlight ids: ${data.highlights.map((x) => x.id).join(', ') || 'none'}.`,
        }
      range = { from: h.start, to: h.end, title: h.title, hookScore: h.hookScore }
    } else if (src.kind === 'chapter') {
      const c = data.chapters.find((x) => x.id === src.id)
      if (!c)
        return {
          error: `There is no chapter ${src.id ?? '(none given)'}. Chapter ids: ${data.chapters.map((x) => x.id).join(', ') || 'none'}.`,
        }
      range = { from: c.start, to: c.end, title: c.title }
    } else if (src.kind === 'search') {
      if (!src.query) return { error: 'A search source needs a query.' }
      const [top] = await this.search.search(data.userId, data.projectId, src.query, 1)
      if (!top)
        return {
          result: {
            text: say(rl, {
              en: `I could not find “${src.query}”.`,
              hinglish: `“${src.query}” nahi mila.`,
              hi: `“${src.query}” नहीं मिला।`,
            }),
            open: { tab: 'search', query: src.query },
          },
        }
      range = { from: top.start, to: top.end, title: src.query }
    }
    if (!range) return { error: 'Unknown source.' }
    const target = input.lengthSec ?? null
    const [from, to] = target
      ? windowFor(
          ctx,
          range.from,
          target,
          range.to > range.from + target ? range.to : Math.max(range.to, range.from + target),
        )
      : [range.from, range.to]
    return {
      result: reelPlan(
        ctx,
        {
          srcFrom: from,
          srcTo: to,
          title: range.title,
          fast: style !== 'calm',
          hookScore: range.hookScore,
        },
        rl,
      ),
    }
  }

  /* --------------------------- checking and saving --------------------------- */

  /**
   * The dry run: the op is applied to a copy of the timeline with the same engine the editor uses. Nothing is saved. A
   * problem comes back as text the model can act on.
   */
  private check(built: BuiltResult, ctx: PlannerContext): string | null {
    const op = built.plan?.op
    if (!op) return null
    const bad = forbiddenOp(op)
    if (bad) return `The ${bad} op is not allowed here.`
    try {
      applyOp(ctx.tl, op)
      return null
    } catch (e) {
      if (e instanceof OpError) return `That edit is not valid on this video: ${e.message}`
      throw e
    }
  }

  /** Saves the plan (if there is one) and returns what the editor shows. */
  private async finish(
    data: ProjectData,
    ctx: PlannerContext,
    rl: RL,
    built: BuiltResult,
  ): Promise<PlannerResult> {
    const problem = this.check(built, ctx)
    if (problem) return { text: failedReply(rl, 'could_not'), chips: HELP_CHIPS }
    let plan: PlannerResult['plan']
    if (built.plan) {
      const row = await savePlan(this.deps.database.db, {
        id: ctx.planId,
        projectId: data.projectId,
        userId: data.userId,
        baseVersion: data.version,
        draft: built.plan,
      })
      plan = toEditPlan(row)
    }
    return {
      text: built.text,
      ...(plan ? { plan } : {}),
      ...(built.question ? { question: built.question } : {}),
      ...(built.chips ? { chips: built.chips } : {}),
      ...(built.open ? { open: built.open } : {}),
      ...(built.route ? { route: built.route } : {}),
      ...(built.action ? { action: built.action } : {}),
    }
  }
}

/** The conversation so far as the model sees it: alternating turns, starting and ending with the person. */
export function conversation(history: Turn[], userText: string): LlmMessage[] {
  const out: LlmMessage[] = []
  const push = (role: 'user' | 'assistant', text: string) => {
    const t = cleanPrompt(text).slice(0, MAX_TURN_CHARS)
    if (!t) return
    const last = out.at(-1)
    if (last && last.role === role && typeof last.content === 'string') last.content += `\n${t}`
    else out.push({ role, content: t })
  }
  for (const turn of history.slice(-MAX_HISTORY))
    push(turn.from === 'user' ? 'user' : 'assistant', turn.text)
  while (out[0]?.role === 'assistant') out.shift()
  push('user', userText)
  return out
}
