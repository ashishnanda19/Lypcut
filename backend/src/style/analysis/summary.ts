import { createHash } from 'node:crypto'
import { dataBlock } from '../../llm/data-block.js'
import { loadPrompt } from '../../llm/prompts.js'
import { LlmError, type Llm, type LlmContext } from '../../llm/index.js'
import { CAPTION_STYLES } from '../../planner/caption-styles.js'
import type { Lang } from '../../modules/account/schema.js'
import type { DerivedProfile } from './profile.js'
import { WRITE_SUMMARY, writeSummaryInput } from './tools.js'

/** The figures a summary is allowed to use. Everything else in the profile stays out of the model's sight. */
export interface SummaryFacts {
  language: Lang
  hookTimingSec: number
  /** Seconds between cuts, or null when the best Reels barely cut. */
  cutEverySec: number | null
  cutPace: number
  topCaptionStyle: string | null
  reels: number
  confidence: DerivedProfile['confidence']
}

export function summaryFacts(profile: DerivedProfile, language: Lang): SummaryFacts {
  const top = profile.captionStyles.find((c) => c.id !== 'custom')
  return {
    language,
    hookTimingSec: profile.hookTimingSec,
    cutEverySec: profile.cutPace >= 0.5 ? Math.round((10 / profile.cutPace) * 10) / 10 : null,
    cutPace: profile.cutPace,
    topCaptionStyle: top ? (CAPTION_STYLES.find((s) => s.id === top.id)?.name ?? null) : null,
    reels: profile.reelsAnalysed,
    confidence: profile.confidence,
  }
}

/** Same figures, same sentence: the summary is made again only when these change. */
export const factsKey = (f: SummaryFacts): string =>
  createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 16)

const hookPhrase = (s: number, lang: Lang) => {
  const n = Math.max(1, Math.ceil(s))
  return lang === 'en'
    ? s < 1
      ? 'under 1 second'
      : `under ${n} seconds`
    : lang === 'hinglish'
      ? s < 1
        ? '1 second ke andar'
        : `${n} second ke andar`
      : s < 1
        ? '1 सेकंड के अंदर'
        : `${n} सेकंड के अंदर`
}

/** The sentence the offline model writes, and the shape a real one is asked to follow. */
export function templateSummary(f: SummaryFacts): string {
  const hook = hookPhrase(f.hookTimingSec, f.language)
  const cut = f.cutEverySec
  const few = f.confidence === 'low'
  if (f.language === 'en')
    return `Your best Reels hook in ${hook} and ${cut ? `cut every ${cut.toFixed(1)} seconds` : 'rarely cut'}${f.topCaptionStyle ? `, with ${f.topCaptionStyle} captions` : ''}${few ? ' (from only a few Reels)' : ''}.`
  if (f.language === 'hinglish')
    return `Aapki best Reels ${hook} hook karti hain aur ${cut ? `har ${cut.toFixed(1)} second mein cut aata hai` : 'kam cut hoti hain'}${f.topCaptionStyle ? `, ${f.topCaptionStyle} captions ke saath` : ''}${few ? ' (sirf kuch Reels se)' : ''}.`
  return `आपकी बेस्ट रील्स ${hook} हुक करती हैं और ${cut ? `हर ${cut.toFixed(1)} सेकंड में कट आता है` : 'कम कट होती हैं'}${f.topCaptionStyle ? `, ${f.topCaptionStyle} कैप्शन के साथ` : ''}${few ? ' (सिर्फ कुछ रील्स से)' : ''}.`
}

const SPELLED = /\b(one|two|three|four|five|six|seven|eight|nine|ten|half|double|triple)\b/i

/**
 * A sentence is accepted only if it uses the given figures. Every number in it must be one of them (or a rounding of one),
 * numbers written as words are refused, and it must be one short line: the model puts the numbers into words, it does not
 * get to change them.
 */
export function acceptSummary(sentence: string, f: SummaryFacts): string | null {
  const s = sentence.replace(/\s+/g, ' ').trim()
  if (s.length < 10 || s.length > 200 || /[\n\r]/.test(sentence)) return null
  if (SPELLED.test(s)) return null
  // Each figure may appear as given or rounded to a whole number. The timing may also be a ceiling ("under 2 seconds").
  const allowed = new Set<number>([10])
  const add = (x: number | null, ceil = false) => {
    if (x === null) return
    for (const v of [x, Math.round(x), Math.round(x * 10) / 10, ...(ceil ? [Math.ceil(x)] : [])])
      allowed.add(v)
  }
  add(f.hookTimingSec, true)
  // "Under 1 second" is how a timing below a second is put.
  allowed.add(Math.max(1, Math.ceil(f.hookTimingSec)))
  add(f.cutEverySec)
  add(f.cutPace)
  add(f.reels)
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) if (!allowed.has(Number(m[0]))) return null
  return s
}

/**
 * One sentence about the profile, in the person's language, from the figures only. Null if the model is unavailable or
 * answers badly: the profile is complete without it.
 */
export async function writeSummary(
  llm: Llm,
  facts: SummaryFacts,
  ctx: LlmContext,
  opts: { maxOutputTokens: number; effort: 'low' | 'medium' | 'high' },
): Promise<string | null> {
  try {
    const reply = await llm.generate(
      {
        purpose: 'style',
        system: loadPrompt('style-summary.v1'),
        context: dataBlock(facts),
        messages: [{ role: 'user', content: 'Write the sentence.' }],
        tools: [WRITE_SUMMARY],
        maxOutputTokens: opts.maxOutputTokens,
        effort: opts.effort,
      },
      ctx,
    )
    if (reply.toolCall?.name !== WRITE_SUMMARY.name || reply.extraToolCalls > 0) return null
    const parsed = writeSummaryInput.safeParse(reply.toolCall.input)
    return parsed.success ? acceptSummary(parsed.data.sentence, facts) : null
  } catch (e) {
    if (e instanceof LlmError) return null
    throw e
  }
}
