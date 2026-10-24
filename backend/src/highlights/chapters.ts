import { dataBlock } from '../llm/data-block.js'
import type { EmbeddingProvider, Llm, LlmContext, LlmMessage } from '../llm/index.js'
import { LlmError } from '../llm/index.js'
import type { Log } from '../lib/log.js'
import { chapterTitle } from '../transcription/insights.js'
import type { CandidateSentence } from './candidates.js'
import type { InsightSource } from './scoring.js'
import { loadPrompt } from '../llm/prompts.js'
import { TITLE_CHAPTERS, titleChaptersInput } from './tools.js'

/** Three to eight chapters, about one for every two minutes. */
export const chapterTarget = (durationSec: number) =>
  Math.min(8, Math.max(3, Math.round(durationSec / 120)))

const cosine = (a: number[], b: number[]) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

function mean(vs: number[][]): number[] {
  const out = new Array<number>(vs[0]?.length ?? 0).fill(0)
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i]! += v[i]!
  const norm = Math.hypot(...out) || 1
  return out.map((x) => x / norm)
}

export interface BoundaryInput {
  sentences: CandidateSentence[]
  /** One unit vector per sentence. */
  vectors: number[][]
  sceneCuts: number[]
  duration: number
}

/**
 * Where the topic changes. Between every two sentences, the sentences just before are compared with the ones just after
 * (as vectors): the less alike they are, the likelier a new topic starts. A pause, a new speaker or a picture cut
 * nudges the score up, because people also change subject there. The strongest points are taken, no two closer than a
 * chapter should be, until there are enough chapters. Returns the sentence index each chapter starts at; the first is 0.
 */
export function chapterStarts(input: BoundaryInput): number[] {
  const { sentences, vectors, sceneCuts, duration } = input
  const n = sentences.length
  if (n === 0) return []
  const want = chapterTarget(duration)
  const minLen = Math.max(6, duration / (want * 2.5))
  const K = 3

  const scores: Array<{ at: number; score: number }> = []
  for (let g = 1; g < n; g++) {
    const left = mean(vectors.slice(Math.max(0, g - K), g))
    const right = mean(vectors.slice(g, Math.min(n, g + K)))
    let score = 1 - cosine(left, right)
    const gap = sentences[g]!.start - sentences[g - 1]!.end
    if (gap >= 0.8) score += 0.12
    if (sentences[g]!.speaker !== sentences[g - 1]!.speaker) score += 0.05
    if (sceneCuts.some((c) => Math.abs(c - sentences[g]!.start) <= 1.5)) score += 0.08
    scores.push({ at: g, score })
  }

  const starts = [0]
  scores.sort((a, b) => b.score - a.score || a.at - b.at)
  for (const { at } of scores) {
    if (starts.length >= want) break
    const t = sentences[at]!.start
    const ok =
      t >= minLen &&
      duration - t >= minLen &&
      starts.every((s) => Math.abs(sentences[s]!.start - t) >= minLen)
    if (ok) starts.push(at)
  }
  return starts.sort((a, b) => a - b)
}

export interface ChapterRange {
  start: number
  end: number
  /** First and last sentence in it. */
  first: number
  last: number
  text: string
}

export function chapterRanges(
  sentences: CandidateSentence[],
  starts: number[],
  duration: number,
): ChapterRange[] {
  return starts.map((first, k) => {
    const nextFirst = starts[k + 1]
    const last = nextFirst === undefined ? sentences.length - 1 : nextFirst - 1
    return {
      first,
      last,
      start: k === 0 ? 0 : sentences[first]!.start,
      end: nextFirst === undefined ? duration : sentences[nextFirst]!.start,
      text: sentences
        .slice(first, last + 1)
        .map((s) => s.text)
        .join(' '),
    }
  })
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

/** The first words of a chapter as its title: used when the model cannot be asked or does not answer usefully. */
export function fallbackTitles(ranges: ChapterRange[], sentences: CandidateSentence[]): string[] {
  return ranges.map((r, k) => (k === 0 ? 'Intro' : chapterTitle(sentences[r.first]!.text)))
}

export async function titleChapters(
  llm: Llm,
  ranges: ChapterRange[],
  sentences: CandidateSentence[],
  meta: { durationSec: number; language: string },
  ctx: LlmContext,
  log: Log,
  maxOutputTokens: number,
  effort: 'low' | 'medium' | 'high',
): Promise<{ titles: string[]; source: InsightSource }> {
  const fallback = fallbackTitles(ranges, sentences)
  if (!ranges.length) return { titles: [], source: 'heuristic' }
  const context = dataBlock({
    video: { durationSec: Math.round(meta.durationSec), language: meta.language },
    chapters: ranges.map((r, index) => ({
      index,
      start: Math.round(r.start),
      end: Math.round(r.end),
      text: r.text.length <= 700 ? r.text : `${r.text.slice(0, 520)} … ${r.text.slice(-160)}`,
    })),
  })
  const messages: LlmMessage[] = [{ role: 'user', content: 'Title every chapter.' }]
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply
    try {
      reply = await llm.generate(
        {
          purpose: 'chapters',
          system: loadPrompt('chapters.v1'),
          context,
          messages,
          tools: [TITLE_CHAPTERS],
          maxOutputTokens,
          effort,
        },
        ctx,
      )
    } catch (e) {
      log.warn(
        { error: e instanceof LlmError ? e.kind : 'unknown', projectId: ctx.projectId },
        'chapter titling failed; using the first words',
      )
      return { titles: fallback, source: 'heuristic' }
    }
    let problem: string | null = null
    if (reply.stop === 'refusal') problem = 'The request was declined.'
    else if (reply.stop === 'max_tokens') problem = 'The answer was cut off. Be briefer.'
    else if (!reply.toolCall || reply.toolCall.name !== TITLE_CHAPTERS.name)
      problem = 'Call title_chapters.'
    else if (reply.extraToolCalls > 0) problem = 'Call title_chapters once.'
    if (!problem && reply.toolCall) {
      const parsed = titleChaptersInput.safeParse(reply.toolCall.input)
      if (!parsed.success)
        problem = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
          .slice(0, 400)
      else {
        const byIndex = new Map<number, string>()
        for (const it of parsed.data.items) {
          if (it.index >= ranges.length) problem = `There is no chapter ${it.index}.`
          else if (byIndex.has(it.index)) problem = `Chapter ${it.index} appears twice.`
          else byIndex.set(it.index, clip(it.title.trim().replace(/[\s.]+$/, ''), 40))
        }
        if (!problem && byIndex.size < ranges.length) problem = 'Title every chapter index.'
        if (!problem) {
          return {
            titles: ranges.map((_, k) => byIndex.get(k) ?? fallback[k]!),
            source: reply.provider === 'fake' ? 'offline' : 'llm',
          }
        }
      }
    }
    log.warn({ attempt, problem, projectId: ctx.projectId }, 'chapter titles were not usable')
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
          {
            type: 'tool_result',
            id: reply.toolCall.id,
            content: problem ?? 'Try again.',
            isError: true,
          },
        ],
      },
    )
  }
  return { titles: fallback, source: 'heuristic' }
}

/** Embeds sentences a batch at a time. */
export async function embedSentences(
  provider: EmbeddingProvider,
  sentences: CandidateSentence[],
): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < sentences.length; i += 64) {
    out.push(
      ...(await provider.embed(
        sentences.slice(i, i + 64).map((s) => s.text),
        'passage',
      )),
    )
  }
  return out
}
