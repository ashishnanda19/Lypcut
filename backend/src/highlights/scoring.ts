import type { Llm, LlmContext, LlmMessage } from '../llm/index.js'
import { LlmError } from '../llm/index.js'
import { dataBlock } from '../llm/data-block.js'
import type { Log } from '../lib/log.js'
import { reasonFor, titleFrom } from '../transcription/insights.js'
import type { Candidate } from './candidates.js'
import { loadPrompt } from '../llm/prompts.js'
import { SCORE_HIGHLIGHTS, scoreHighlightsInput } from './tools.js'

export type InsightSource = 'llm' | 'offline' | 'heuristic'

export interface ScoredCandidate {
  id: string
  title: string
  hookScore: number
  reason: string
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

/** How many characters of each window's speech the model reads: the opening matters most, then how it ends. */
function excerpt(text: string): string {
  return text.length <= 650 ? text : `${text.slice(0, 480)} … ${text.slice(-150)}`
}

export interface ScoringMeta {
  durationSec: number
  language: string
}

/** What the cheap checks alone say, used when the model cannot be asked or its answer cannot be used. */
export function heuristicScores(candidates: Candidate[]): ScoredCandidate[] {
  return candidates.map((c) => ({
    id: c.id,
    title: titleFrom(c.text),
    hookScore: c.preScore,
    reason: reasonFor(new Set(c.signals) as never),
  }))
}

/**
 * Asks the model to score every candidate in one call. The answer is checked: unknown or repeated ids, scores outside
 * 0-100 and the wrong tool are all refused, the model is told what was wrong once, and if it still gets it wrong (or the
 * service is down) the cheap scores are used, so a project never waits on, or fails because of, the model.
 */
export async function scoreCandidates(
  llm: Llm,
  candidates: Candidate[],
  meta: ScoringMeta,
  ctx: LlmContext,
  log: Log,
  maxOutputTokens: number,
  effort: 'low' | 'medium' | 'high',
): Promise<{ scores: ScoredCandidate[]; source: InsightSource }> {
  if (!candidates.length) return { scores: [], source: 'heuristic' }
  const ids = new Set(candidates.map((c) => c.id))
  const context = dataBlock({
    video: { durationSec: Math.round(meta.durationSec), language: meta.language },
    candidates: candidates.map((c) => ({
      id: c.id,
      start: round1(c.start),
      end: round1(c.end),
      signals: c.signals,
      pace: c.pace,
      fillerShare: c.fillerShare,
      text: excerpt(c.text),
    })),
  })

  const messages: LlmMessage[] = [{ role: 'user', content: 'Score every candidate.' }]
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply
    try {
      reply = await llm.generate(
        {
          purpose: 'highlights',
          system: loadPrompt('highlights.v1'),
          context,
          messages,
          tools: [SCORE_HIGHLIGHTS],
          maxOutputTokens,
          effort,
        },
        ctx,
      )
    } catch (e) {
      log.warn(
        { error: e instanceof LlmError ? e.kind : 'unknown', projectId: ctx.projectId },
        'highlight scoring failed; using the cheap scores',
      )
      return { scores: heuristicScores(candidates), source: 'heuristic' }
    }

    const problem = check(reply, ids)
    if (problem.ok) {
      const byId = new Map(problem.items.map((i) => [i.id, i]))
      const fallback = new Map(heuristicScores(candidates).map((s) => [s.id, s]))
      const scores = candidates.map((c) => {
        const m = byId.get(c.id)
        return m
          ? {
              id: c.id,
              title: clip(m.title.trim(), 60),
              hookScore: Math.round(m.hookScore),
              reason: clip(m.reason.trim(), 140),
            }
          : fallback.get(c.id)!
      })
      return { scores, source: reply.provider === 'fake' ? 'offline' : 'llm' }
    }
    log.warn(
      { attempt, problem: problem.error, projectId: ctx.projectId },
      'highlight scoring answer was not usable',
    )
    if (!reply.toolCall) break
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
          { type: 'tool_result', id: reply.toolCall.id, content: problem.error, isError: true },
        ],
      },
    )
  }
  return { scores: heuristicScores(candidates), source: 'heuristic' }
}

function check(
  reply: { toolCall?: { name: string; input: unknown }; extraToolCalls: number; stop: string },
  ids: Set<string>,
):
  | { ok: false; error: string }
  | { ok: true; items: Array<{ id: string; title: string; hookScore: number; reason: string }> } {
  if (reply.stop === 'refusal') return { ok: false, error: 'The request was declined.' }
  if (reply.stop === 'max_tokens')
    return { ok: false, error: 'The answer was cut off. Be briefer.' }
  if (!reply.toolCall || reply.toolCall.name !== SCORE_HIGHLIGHTS.name)
    return { ok: false, error: 'Call score_highlights.' }
  if (reply.extraToolCalls > 0)
    return { ok: false, error: 'Call score_highlights once, with every candidate in one call.' }
  const parsed = scoreHighlightsInput.safeParse(reply.toolCall.input)
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 400),
    }
  const seen = new Set<string>()
  for (const item of parsed.data.items) {
    if (!ids.has(item.id))
      return { ok: false, error: `"${item.id}" is not one of the candidate ids.` }
    if (seen.has(item.id)) return { ok: false, error: `"${item.id}" appears twice.` }
    seen.add(item.id)
  }
  // Scoring only some of them is no use: ask again rather than guess the rest.
  if (seen.size < Math.ceil(ids.size * 0.5))
    return { ok: false, error: 'Score every candidate id.' }
  return { ok: true, items: parsed.data.items }
}

const round1 = (n: number) => Math.round(n * 10) / 10
