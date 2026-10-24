import type {
  Chapter,
  EditPlan,
  EditStripSegment,
  Highlight,
  Lang,
  QuestionCard,
  StyleProfile,
  Timeline,
  TimelineItem,
  TimelineOp,
  Transcript,
} from '@/types'
import { AI } from '@/lib/config'
import { uid } from '@/lib/ids'
import { applyOp } from '@lypcut/timeline-core'
import { coverage, splitByCoverage, timeAtSource, timelineDuration } from '@lypcut/timeline-core'
import {
  captionsForTimeline,
  keepRangeOp,
  pauseRanges,
  removeFillersOp,
  trimPausesOp,
  wordRange,
} from '@lypcut/timeline-core'
import { searchTranscript } from '@/lib/search'
import { formatDuration } from '@/lib/time'
import { CAPTION_STYLES, captionStyle } from './captionStyles'

/**
 * A stand-in for the language model. It reads a request in Hindi, Hinglish or English and answers
 * with either words, a tappable question, or an Edit card (a validated TimelineOp plus a summary).
 *
 * The contract is the point: the real planner returns the same shapes, so swapping it in changes
 * nothing in the UI. The planner never edits anything. It only proposes ops.
 */

export interface PlannerContext {
  tl: Timeline
  tr: Transcript
  highlights: Highlight[]
  chapters: Chapter[]
  lang: Lang
  style?: StyleProfile
  applyStyle: boolean
  /** Timeline time of the playhead. */
  playhead: number
}

export type ChatTab = 'chat' | 'transcript' | 'search' | 'clips' | 'history'

export interface PlannerResult {
  text: string
  plan?: EditPlan
  question?: QuestionCard
  chips?: string[]
  /** Switch the left panel (and run a search) after replying. */
  open?: { tab: ChatTab; query?: string }
  route?: string
  action?: 'undo' | 'redo'
}

type RL = 'en' | 'hinglish' | 'hi'
type Say = { en: string; hinglish: string; hi?: string }

const DEV = /[ऀ-ॿ]/
const replyLang = (prompt: string, lang: Lang): RL => (DEV.test(prompt) ? 'hi' : lang)
const say = (rl: RL, s: Say) =>
  rl === 'hi' ? (s.hi ?? s.hinglish) : rl === 'hinglish' ? s.hinglish : s.en

/* -------------------------------- helpers -------------------------------- */

const has = (text: string, words: string[]) => words.some((w) => text.includes(w))
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,!?;:"“”()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const secs = (n: number) => formatDuration(Math.round(n))

/** A small before/after strip for the Edit card: kept, cut and added stretches. */
function stripFromCuts(tl: Timeline, cuts: Array<[number, number]>): EditStripSegment[] {
  const cov = coverage(tl)
  if (!cov.length) return [{ kind: 'keep', weight: 1 }]
  const first = cov[0]![0]
  const last = cov[cov.length - 1]![1]
  const total = Math.max(1, last - first)
  const inside = cuts
    .flatMap(([a, b]) => splitByCoverage(tl, a, b).covered)
    .sort((x, y) => x[0] - y[0])
  const floor = total * 0.012
  const out: EditStripSegment[] = []
  let cursor = first
  for (const [a, b] of inside) {
    if (a - cursor > 0.01) out.push({ kind: 'keep', weight: a - cursor })
    out.push({ kind: 'cut', weight: Math.max(b - a, floor) })
    cursor = b
  }
  if (last - cursor > 0.01) out.push({ kind: 'keep', weight: last - cursor })
  return out.length ? out : [{ kind: 'keep', weight: 1 }]
}

function cutRanges(op: TimelineOp): Array<[number, number]> {
  if (op.type === 'cutSource') return [[op.srcFrom, op.srcTo]]
  if (op.type === 'batch') return op.ops.flatMap(cutRanges)
  return []
}

function firstCutTime(tl: Timeline, op: TimelineOp): number | undefined {
  const r = cutRanges(op).sort((a, b) => a[0] - b[0])[0]
  if (!r) return undefined
  return timeAtSource(tl, r[0])
}

function makePlan(p: Omit<EditPlan, 'id'>): EditPlan {
  return { id: uid('edit'), ...p }
}

/* ------------------------------ plan builders ----------------------------- */

function fillersPlan(ctx: PlannerContext, rl: RL): PlannerResult {
  const r = removeFillersOp(ctx.tl, ctx.tr.words)
  if (!r) {
    return {
      text: say(rl, {
        en: 'No filler words are left in your edit. Nice and tight.',
        hinglish: 'Ab koi filler word bacha hi nahi. Edit already tight hai.',
        hi: 'अब कोई फिलर वर्ड नहीं बचा। एडिट पहले से टाइट है।',
      }),
      chips: ['Trim long pauses', 'Add captions'],
    }
  }
  const counts = new Map<string, number>()
  for (const w of ctx.tr.words)
    if (w.filler) counts.set(w.text.toLowerCase(), (counts.get(w.text.toLowerCase()) ?? 0) + 1)
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => `“${w}”`)
    .join(', ')
  return {
    text: say(rl, {
      en: `Found ${r.count} filler words, like ${top}. Here is the cleanup. Preview it first if you like.`,
      hinglish: `${r.count} filler words mile, jaise ${top}. Ye raha cleanup. Chaho to pehle preview dekh lo.`,
      hi: `${r.count} फिलर वर्ड मिले, जैसे ${top}। ये रहा क्लीनअप। चाहें तो पहले प्रीव्यू देख लें।`,
    }),
    plan: makePlan({
      title: say(rl, {
        en: `Remove ${r.count} filler words`,
        hinglish: `${r.count} filler words hatao`,
        hi: `${r.count} फिलर वर्ड हटाएं`,
      }),
      description: say(rl, {
        en: `Cuts ${top} and the pauses around them.`,
        hinglish: `${top} aur unke aaspaas ke pauses cut honge.`,
        hi: `${top} और आसपास के पॉज़ कट होंगे।`,
      }),
      op: r.op,
      strip: stripFromCuts(ctx.tl, cutRanges(r.op)),
      summary: [
        { label: 'Cuts', value: String(r.count), tone: 'coral' },
        { label: 'Saved', value: `${r.seconds.toFixed(1)}s`, tone: 'teal' },
      ],
      focus: firstCutTime(ctx.tl, r.op),
    }),
    chips: ['Trim long pauses', 'Add captions'],
  }
}

function pausesPlan(ctx: PlannerContext, rl: RL): PlannerResult {
  const r = trimPausesOp(ctx.tl, ctx.tr.words)
  if (!r) {
    return {
      text: say(rl, {
        en: 'There are no long pauses left to trim.',
        hinglish: 'Koi lamba pause bacha nahi hai.',
        hi: 'कोई लंबा पॉज़ नहीं बचा है।',
      }),
      chips: ['Remove filler words', 'Add captions'],
    }
  }
  return {
    text: say(rl, {
      en: `${r.count} pauses are longer than 0.7 seconds. I will shorten each to a natural beat, not remove it.`,
      hinglish: `${r.count} pauses 0.7 second se lambe hain. Main unhe ek natural beat tak chhota karunga, poora nahi hataunga.`,
      hi: `${r.count} पॉज़ 0.7 सेकंड से लंबे हैं। मैं इन्हें एक स्वाभाविक बीट तक छोटा करूंगा।`,
    }),
    plan: makePlan({
      title: say(rl, {
        en: `Tighten ${r.count} long pauses`,
        hinglish: `${r.count} lambe pauses tight karo`,
        hi: `${r.count} लंबे पॉज़ छोटे करें`,
      }),
      description: say(rl, {
        en: 'Keeps a short natural beat so it does not sound rushed.',
        hinglish: 'Ek chhota natural beat rakhta hai, taaki jaldi-jaldi na lage.',
        hi: 'एक छोटा स्वाभाविक बीट रखता है ताकि जल्दबाज़ी न लगे।',
      }),
      op: r.op,
      strip: stripFromCuts(ctx.tl, cutRanges(r.op)),
      summary: [
        { label: 'Pauses', value: String(r.count), tone: 'coral' },
        { label: 'Saved', value: `${r.seconds.toFixed(1)}s`, tone: 'teal' },
      ],
      focus: firstCutTime(ctx.tl, r.op),
    }),
    chips: ['Remove filler words', 'Add captions'],
  }
}

function styleIdFor(ctx: PlannerContext): string {
  if (ctx.applyStyle && ctx.style?.connected && ctx.style.captionStyles[0])
    return ctx.style.captionStyles[0].id
  return ctx.tl.settings.captionStyleId
}

function captionsPlan(ctx: PlannerContext, rl: RL): PlannerResult {
  const items = captionsForTimeline(ctx.tl, ctx.tr.words)
  if (!items.length) {
    return {
      text: say(rl, {
        en: 'There is no speech left to caption.',
        hinglish: 'Caption ke liye speech bachi hi nahi.',
      }),
    }
  }
  const sid = styleIdFor(ctx)
  const style = captionStyle(sid)
  const ops: TimelineOp[] = [{ type: 'addCaptions', items, replace: true }]
  if (sid !== ctx.tl.settings.captionStyleId || !ctx.tl.settings.captionsOn)
    ops.push({ type: 'setCaptionStyle', styleId: sid })
  const devanagari =
    ctx.tr.words.filter((w) => w.language === 'hi').length > ctx.tr.words.length / 2
  return {
    text: say(rl, {
      en: `Captions are ready: ${items.length} short phrases in the ${style.name} style. Hindi words stay in Devanagari.`,
      hinglish: `Captions ready hain: ${items.length} chhote phrases, ${style.name} style mein. Hindi words Devanagari mein dikhenge.`,
      hi: `कैप्शन तैयार हैं: ${items.length} छोटे वाक्यांश, ${style.name} स्टाइल में।`,
    }),
    plan: makePlan({
      title: say(rl, { en: 'Add captions', hinglish: 'Captions lagao', hi: 'कैप्शन जोड़ें' }),
      description: say(rl, {
        en: `${items.length} phrases, ${style.name} style. Change the look any time in Properties.`,
        hinglish: `${items.length} phrases, ${style.name} style. Look kabhi bhi Properties mein badal sakte ho.`,
        hi: `${items.length} वाक्यांश, ${style.name} स्टाइल। लुक कभी भी बदल सकते हैं।`,
      }),
      op: ops.length === 1 ? ops[0]! : { type: 'batch', ops, label: 'Add captions' },
      strip: [
        { kind: 'keep', weight: 1 },
        { kind: 'add', weight: 8 },
        { kind: 'keep', weight: 1 },
      ],
      summary: [
        { label: 'Captions', value: String(items.length), tone: 'teal' },
        { label: 'Style', value: style.name, tone: 'saffron' },
        ...(devanagari ? [{ label: 'Script', value: 'Devanagari', tone: 'neutral' as const }] : []),
      ],
      focus: items[0]?.start,
    }),
    chips: ['Make a 30 second Reel', 'Switch to karaoke captions'],
  }
}

function captionStylePlan(ctx: PlannerContext, id: string, rl: RL): PlannerResult {
  const style = captionStyle(id)
  const hasCaps = Object.values(ctx.tl.items).some((i) => i.kind === 'caption')
  const ops: TimelineOp[] = []
  if (!hasCaps) {
    const items = captionsForTimeline(ctx.tl, ctx.tr.words)
    if (items.length) ops.push({ type: 'addCaptions', items, replace: true })
  }
  ops.push({ type: 'setCaptionStyle', styleId: id })
  return {
    text: say(rl, {
      en: `${style.name} it is. ${style.note}`,
      hinglish: `${style.name} style laga deta hoon. ${style.note}`,
      hi: `${style.name} स्टाइल लगा देता हूं।`,
    }),
    plan: makePlan({
      title: say(rl, {
        en: `Use ${style.name} captions`,
        hinglish: `${style.name} captions lagao`,
        hi: `${style.name} कैप्शन लगाएं`,
      }),
      description: style.note,
      op: ops.length === 1 ? ops[0]! : { type: 'batch', ops, label: `Use ${style.name} captions` },
      strip: [
        { kind: 'keep', weight: 1 },
        { kind: 'add', weight: 6 },
        { kind: 'keep', weight: 1 },
      ],
      summary: [{ label: 'Style', value: style.name, tone: 'saffron' }],
    }),
    chips: CAPTION_STYLES.filter((s) => s.id !== id)
      .slice(0, 2)
      .map((s) => `Switch to ${s.name} captions`),
  }
}

/** Choose a window that starts on a sentence and ends on one, close to the target length. */
function windowFor(
  ctx: PlannerContext,
  srcStart: number,
  target: number | null,
  hardEnd: number,
): [number, number] {
  const sents = ctx.tr.sentences
  const startSent = sents.find((s) => s.end > srcStart) ?? sents[0]!
  const from = Math.min(startSent.start, srcStart)
  if (target == null) return [from, hardEnd]
  const want = from + target
  let to = hardEnd
  let bestDiff = Infinity
  for (const s of sents) {
    if (s.end <= from + 3) continue
    const d = Math.abs(s.end - want)
    if (s.end <= want + 4 && d < bestDiff) {
      bestDiff = d
      to = s.end
    }
  }
  return [from, Math.min(Math.max(to, from + Math.min(target, 8)), ctx.tl.sourceDuration)]
}

export interface ReelOptions {
  /** Source range to build the Reel from. */
  srcFrom: number
  srcTo: number
  title: string
  fast: boolean
  hookScore?: number
}

/** Build the "Make a Reel" edit: keep one range, optionally tighten it, add captions. */
export function reelPlan(ctx: PlannerContext, o: ReelOptions, rl: RL): PlannerResult {
  const cuts: TimelineOp[] = [keepRangeOp(o.srcFrom, o.srcTo, ctx.tl.sourceDuration)]
  let tl = applyOp(ctx.tl, cuts[0]!).timeline
  let fillerCount = 0
  let pauseCount = 0
  if (o.fast) {
    const f = removeFillersOp(tl, ctx.tr.words)
    if (f) {
      cuts.push(f.op)
      tl = applyOp(tl, f.op).timeline
      fillerCount = f.count
    }
    const p = trimPausesOp(tl, ctx.tr.words)
    if (p) {
      cuts.push(p.op)
      tl = applyOp(tl, p.op).timeline
      pauseCount = p.count
    }
  }
  const caps = captionsForTimeline(tl, ctx.tr.words)
  const sid = styleIdFor(ctx)
  cuts.push({ type: 'addCaptions', items: caps, replace: true })
  cuts.push({ type: 'setCaptionStyle', styleId: sid })
  const length = timelineDuration(tl)
  const title = say(rl, {
    en: `Make a Reel: ${o.title}`,
    hinglish: `Reel banao: ${o.title}`,
    hi: `रील बनाएं: ${o.title}`,
  })
  const plan = makePlan({
    title,
    description: say(rl, {
      en: `Keeps ${secs(o.srcFrom)} to ${secs(o.srcTo)}${o.fast ? ', removes fillers and long pauses' : ''}, then adds ${captionStyle(sid).name} captions.`,
      hinglish: `${secs(o.srcFrom)} se ${secs(o.srcTo)} rakhta hai${o.fast ? ', fillers aur lambe pauses hatata hai' : ''}, phir ${captionStyle(sid).name} captions lagata hai.`,
      hi: `${secs(o.srcFrom)} से ${secs(o.srcTo)} रखता है, फिर कैप्शन जोड़ता है।`,
    }),
    op: { type: 'batch', ops: cuts, label: title },
    strip: [
      { kind: 'cut', weight: Math.max(0.5, o.srcFrom / 12) },
      { kind: 'keep', weight: Math.max(1, (o.srcTo - o.srcFrom) / 4) },
      { kind: 'cut', weight: Math.max(0.5, (ctx.tl.sourceDuration - o.srcTo) / 12) },
    ],
    summary: [
      { label: 'Length', value: secs(length), tone: 'teal' },
      ...(o.hookScore
        ? [{ label: 'Hook', value: String(o.hookScore), tone: 'saffron' as const }]
        : []),
      ...(fillerCount
        ? [{ label: 'Fillers', value: String(fillerCount), tone: 'coral' as const }]
        : []),
      ...(pauseCount
        ? [{ label: 'Pauses', value: String(pauseCount), tone: 'coral' as const }]
        : []),
    ],
    focus: 0,
  })
  return {
    text: say(rl, {
      en: `This Reel runs ${secs(length)} and starts on the hook. Preview it, then apply.`,
      hinglish: `Ye Reel ${secs(length)} ki hai aur seedha hook se shuru hoti hai. Preview dekho, phir apply karo.`,
      hi: `यह रील ${secs(length)} की है और सीधे हुक से शुरू होती है। प्रीव्यू देखें, फिर अप्लाई करें।`,
    }),
    plan,
    chips: ['Blur the background', 'Switch to boxed captions'],
  }
}

/* --------------------------------- questions -------------------------------- */

function question(
  intent: string,
  prompt: string,
  options: Array<[string, string, string?]>,
): QuestionCard {
  return {
    id: uid('q'),
    intent,
    prompt,
    options: options.map(([id, label, hint]) => ({ id, label, hint })),
  }
}

function parseIntent(intent: string): {
  kind: string
  step?: string
  part?: string
  len?: string
  style?: string
} {
  const [kind = '', ...rest] = intent.split('|')
  const kv = Object.fromEntries(rest.map((p) => p.split('=')))
  return { kind, ...kv }
}

const topHook = (ctx: PlannerContext) =>
  [...ctx.highlights].sort((a, b) => b.hookScore - a.hookScore)[0]

function askPart(ctx: PlannerContext, rl: RL, len?: string, style?: string): PlannerResult {
  const hook = topHook(ctx)
  const extra = `${len ? `|len=${len}` : ''}${style ? `|style=${style}` : ''}`
  return {
    text: say(rl, {
      en: 'Happy to. Which part should the Reel come from?',
      hinglish: 'Zaroor. Reel video ke kis hisse se banani hai?',
      hi: 'ज़रूर। रील वीडियो के किस हिस्से से बनानी है?',
    }),
    question: question(
      `reel|step=part${extra}`,
      say(rl, { en: 'Which part?', hinglish: 'Kaunsa hissa?', hi: 'कौन सा हिस्सा?' }),
      [
        [
          'best',
          say(rl, { en: 'My best hook', hinglish: 'Sabse accha hook', hi: 'सबसे अच्छा हुक' }),
          hook ? `${hook.title} · ${hook.hookScore}` : undefined,
        ],
        [
          'here',
          say(rl, {
            en: 'From where I am now',
            hinglish: 'Jahan abhi hoon wahan se',
            hi: 'जहां अभी हूं वहां से',
          }),
          secs(ctx.playhead),
        ],
        ['all', say(rl, { en: 'The whole video', hinglish: 'Poori video', hi: 'पूरी वीडियो' })],
      ],
    ),
  }
}

function askLength(rl: RL, part: string, style?: string): PlannerResult {
  return {
    text: say(rl, {
      en: 'How long should it be?',
      hinglish: 'Kitni lambi chahiye?',
      hi: 'कितनी लंबी चाहिए?',
    }),
    question: question(
      `reel|step=len|part=${part}${style ? `|style=${style}` : ''}`,
      say(rl, { en: 'Length', hinglish: 'Length', hi: 'लंबाई' }),
      [
        ['15', '15 s', say(rl, { en: 'Quick hit', hinglish: 'Jhatpat', hi: 'झटपट' })],
        [
          '30',
          '30 s',
          say(rl, { en: 'Most popular', hinglish: 'Sabse popular', hi: 'सबसे लोकप्रिय' }),
        ],
        [
          '60',
          '60 s',
          say(rl, { en: 'Tell the story', hinglish: 'Poori kahani', hi: 'पूरी कहानी' }),
        ],
      ],
    ),
  }
}

function askStyle(rl: RL, part: string, len: string): PlannerResult {
  return {
    text: say(rl, {
      en: 'And the pace of the edit?',
      hinglish: 'Aur edit ki pace kaisi ho?',
      hi: 'और एडिट की गति कैसी हो?',
    }),
    question: question(
      `reel|step=style|part=${part}|len=${len}`,
      say(rl, { en: 'Pace', hinglish: 'Pace', hi: 'गति' }),
      [
        [
          'fast',
          say(rl, { en: 'Fast and punchy', hinglish: 'Fast aur punchy', hi: 'तेज़ और दमदार' }),
          say(rl, {
            en: 'Removes fillers and long pauses',
            hinglish: 'Fillers aur lambe pauses hatata hai',
            hi: 'फिलर और लंबे पॉज़ हटाता है',
          }),
        ],
        [
          'calm',
          say(rl, { en: 'Keep it natural', hinglish: 'Natural rakho', hi: 'स्वाभाविक रखें' }),
          say(rl, {
            en: 'Leaves your pacing alone',
            hinglish: 'Aapki pace ko chhedta nahi',
            hi: 'आपकी गति नहीं बदलता',
          }),
        ],
      ],
    ),
  }
}

function finishReel(
  ctx: PlannerContext,
  rl: RL,
  part: string,
  len: string | undefined,
  style: string | undefined,
): PlannerResult {
  const fast = style !== 'calm'
  const target = len && len !== 'full' ? Number(len) : null
  const hook = topHook(ctx)
  let from = 0
  let to = ctx.tl.sourceDuration
  let title = say(rl, { en: 'Full video', hinglish: 'Poori video', hi: 'पूरी वीडियो' })
  let hookScore: number | undefined
  if (part === 'best' && hook) {
    ;[from, to] = windowFor(
      ctx,
      hook.start,
      target,
      hook.end > hook.start + (target ?? 0)
        ? hook.end
        : Math.max(hook.end, hook.start + (target ?? 30)),
    )
    title = hook.title
    hookScore = hook.hookScore
  } else if (part === 'here') {
    ;[from, to] = windowFor(ctx, nearestSource(ctx), target, ctx.tl.sourceDuration)
    title = say(rl, { en: 'From the playhead', hinglish: 'Playhead se', hi: 'प्लेहेड से' })
  } else if (target) {
    ;[from, to] = windowFor(ctx, 0, target, ctx.tl.sourceDuration)
  }
  return reelPlan(ctx, { srcFrom: from, srcTo: to, title, fast, hookScore }, rl)
}

function nearestSource(ctx: PlannerContext): number {
  const items = Object.values(ctx.tl.items).filter((i): i is TimelineItem => i.kind === 'video')
  const it = items.find((i) => ctx.playhead >= i.start && ctx.playhead < i.start + i.duration)
  return it ? it.srcIn + (ctx.playhead - it.start) : 0
}

/** The person tapped an answer on a question card. */
export function answerQuestion(
  q: QuestionCard,
  optionId: string,
  ctx: PlannerContext,
): PlannerResult {
  const rl: RL = ctx.lang
  const i = parseIntent(q.intent)
  if (i.kind !== 'reel') return { text: say(rl, { en: 'Got it.', hinglish: 'Theek hai.' }) }
  if (i.step === 'part') {
    if (optionId === 'all' && !i.len) return askLength(rl, 'all', i.style)
    if (!i.len) return askLength(rl, optionId, i.style)
    if (!i.style) return askStyle(rl, optionId, i.len)
    return finishReel(ctx, rl, optionId, i.len, i.style)
  }
  if (i.step === 'len') {
    if (!i.style) return askStyle(rl, i.part ?? 'best', optionId)
    return finishReel(ctx, rl, i.part ?? 'best', optionId, i.style)
  }
  return finishReel(ctx, rl, i.part ?? 'best', i.len, optionId)
}

/* ---------------------------------- main ----------------------------------- */

const SECONDS = /(\d{1,3})\s*(?:sec|secs|second|seconds|s\b|सेकंड|सैकंड|सेकेंड)/
const MINUTE = /(\d{1,2})\s*(?:min|mins|minute|minutes|मिनट)/

function effectPlan(ctx: PlannerContext, kind: 'blur' | 'zoom', rl: RL): PlannerResult {
  const track = ctx.tl.tracks.find((t) => t.kind === 'effects')
  const dur = Math.min(
    kind === 'blur' ? 8 : 4,
    Math.max(2, timelineDuration(ctx.tl) - ctx.playhead),
  )
  const item: TimelineItem = {
    id: uid('fx'),
    trackId: track?.id ?? 'trk_effects',
    kind: 'effect',
    label: kind === 'blur' ? 'Background blur' : 'Punch-in zoom',
    start: ctx.playhead,
    duration: dur,
    srcIn: 0,
    meta: { effect: kind, amount: kind === 'blur' ? 0.6 : 1.35, ai: true },
  }
  const name =
    kind === 'blur'
      ? say(rl, {
          en: 'Blur the background',
          hinglish: 'Background blur karo',
          hi: 'बैकग्राउंड ब्लर करें',
        })
      : say(rl, { en: 'Punch in', hinglish: 'Zoom-in lagao', hi: 'ज़ूम-इन लगाएं' })
  return {
    text: say(rl, {
      en: `${name} for ${dur.toFixed(0)} seconds from the playhead. It sits on the Effects track, which appears in Advanced mode.`,
      hinglish: `Playhead se ${dur.toFixed(0)} second ke liye ${name}. Ye Effects track par rahega, jo Advanced mode mein dikhta hai.`,
      hi: `प्लेहेड से ${dur.toFixed(0)} सेकंड के लिए। यह Effects ट्रैक पर रहेगा।`,
    }),
    plan: makePlan({
      title: name,
      description: say(rl, {
        en: `${secs(ctx.playhead)} to ${secs(ctx.playhead + dur)}. Remove it any time.`,
        hinglish: `${secs(ctx.playhead)} se ${secs(ctx.playhead + dur)}. Kabhi bhi hata sakte ho.`,
        hi: `${secs(ctx.playhead)} से ${secs(ctx.playhead + dur)}।`,
      }),
      op: { type: 'addEffect', item },
      strip: [
        { kind: 'keep', weight: 2 },
        { kind: 'add', weight: 3 },
        { kind: 'keep', weight: 4 },
      ],
      summary: [{ label: 'Length', value: `${dur.toFixed(0)}s`, tone: 'teal' }],
      focus: ctx.playhead,
    }),
  }
}

function searchReply(ctx: PlannerContext, query: string, rl: RL): PlannerResult {
  const results = searchTranscript(ctx.tr, query, 3)
  if (!results.length) {
    return {
      text: say(rl, {
        en: `I could not find “${query}”. Try a different word, or ask in Hindi.`,
        hinglish: `“${query}” nahi mila. Doosra word try karo, ya Hindi mein poochho.`,
        hi: `“${query}” नहीं मिला। कोई दूसरा शब्द आज़माएं।`,
      }),
      open: { tab: 'search', query },
    }
  }
  const top = results[0]!
  const reel = reelPlan(ctx, { srcFrom: top.start, srcTo: top.end, title: query, fast: true }, rl)
  return {
    ...reel,
    text: say(rl, {
      en: `Found ${results.length} place${results.length > 1 ? 's' : ''} where you talk about “${query}”. The best one is at ${secs(top.start)}. Here is a Reel from it, and the Search tab has the rest.`,
      hinglish: `${results.length} jagah mili jahan aap “${query}” ke baare mein bol rahe ho. Sabse achhi ${secs(top.start)} par hai. Usse Reel ye rahi, baaki Search tab mein hain.`,
      hi: `“${query}” के बारे में ${results.length} जगह मिलीं। सबसे अच्छी ${secs(top.start)} पर है।`,
    }),
    open: { tab: 'search', query },
  }
}

function bestHooks(ctx: PlannerContext, rl: RL): PlannerResult {
  const sorted = [...ctx.highlights].sort((a, b) => b.hookScore - a.hookScore).slice(0, 3)
  if (!sorted.length)
    return {
      text: say(rl, {
        en: 'I did not find strong hooks yet.',
        hinglish: 'Abhi strong hooks nahi mile.',
      }),
    }
  const top = sorted[0]!
  const lines = sorted.map((h, n) => `${n + 1}. ${h.title} (${h.hookScore})`).join('\n')
  const reel = reelPlan(
    ctx,
    { srcFrom: top.start, srcTo: top.end, title: top.title, fast: true, hookScore: top.hookScore },
    rl,
  )
  return {
    ...reel,
    text: say(rl, {
      en: `Your strongest hooks:\n${lines}\n\nThe top one opens with: ${top.reason} Here is a Reel built from it.`,
      hinglish: `Aapke sabse strong hooks:\n${lines}\n\nTop wala isliye: ${top.reason} Isse ek Reel bana di.`,
      hi: `आपके सबसे मज़बूत हुक:\n${lines}\n\nटॉप वाले से एक रील बनाई है।`,
    }),
    open: { tab: 'clips' },
  }
}

function myStyle(ctx: PlannerContext, rl: RL): PlannerResult {
  if (!ctx.style?.connected) {
    return {
      text: say(rl, {
        en: `I can match your style once I have seen your Reels. Connect Instagram, or upload three to five Reels, on the Style page. It takes a minute.`,
        hinglish: `Aapki style match karne ke liye pehle aapki Reels dekhni hongi. Style page par Instagram connect karo, ya 3 se 5 Reels upload karo.`,
        hi: `आपकी स्टाइल मैच करने के लिए पहले आपकी रील्स देखनी होंगी। Style पेज पर Instagram कनेक्ट करें।`,
      }),
      route: '/app/style',
      chips: ['Add captions'],
    }
  }
  const sid = ctx.style.captionStyles[0]?.id ?? 'saffron-pop'
  const style = captionStyle(sid)
  const pause = trimPausesOp(ctx.tl, ctx.tr.words)
  const ops: TimelineOp[] = []
  const caps = captionsForTimeline(ctx.tl, ctx.tr.words)
  if (caps.length) ops.push({ type: 'addCaptions', items: caps, replace: true })
  ops.push({ type: 'setCaptionStyle', styleId: sid })
  if (pause) ops.push(pause.op)
  return {
    text: say(rl, {
      en: `Your top Reels use ${style.name} captions and cut roughly every ${ctx.style.cutPace.toFixed(1)} seconds. Here is that look.`,
      hinglish: `Aapki top Reels mein ${style.name} captions hain aur har ${ctx.style.cutPace.toFixed(1)} second mein cut aata hai. Ye raha wahi look.`,
      hi: `आपकी टॉप रील्स में ${style.name} कैप्शन हैं। यह रहा वही लुक।`,
    }),
    plan: makePlan({
      title: say(rl, {
        en: 'Match my style',
        hinglish: 'Meri style lagao',
        hi: 'मेरी स्टाइल लगाएं',
      }),
      description: say(rl, {
        en: `${style.name} captions and tighter pauses, learned from your best Reels.`,
        hinglish: `${style.name} captions aur tight pauses, aapki best Reels se seekhe.`,
        hi: `${style.name} कैप्शन और छोटे पॉज़।`,
      }),
      op: { type: 'batch', ops, label: 'Match my style' },
      strip: pause
        ? stripFromCuts(ctx.tl, cutRanges(pause.op))
        : [
            { kind: 'keep', weight: 1 },
            { kind: 'add', weight: 4 },
          ],
      summary: [
        { label: 'Captions', value: style.name, tone: 'saffron' },
        { label: 'Cut pace', value: `${ctx.style.cutPace.toFixed(1)}s`, tone: 'teal' },
      ],
    }),
  }
}

function trimIntro(ctx: PlannerContext, rl: RL): PlannerResult {
  const first = ctx.tr.sentences[0]
  const second = ctx.tr.sentences[1]
  if (!first || !second)
    return {
      text: say(rl, {
        en: 'There is nothing to trim at the start.',
        hinglish: 'Shuru mein trim karne ko kuch nahi.',
      }),
    }
  const op: TimelineOp = { type: 'cutSource', srcFrom: 0, srcTo: second.start - 0.05 }
  return {
    text: say(rl, {
      en: 'I will cut the opening line so the video starts on the second sentence.',
      hinglish: 'Pehli line hata deta hoon, video doosri sentence se shuru hogi.',
      hi: 'पहली पंक्ति हटा देता हूं, वीडियो दूसरे वाक्य से शुरू होगा।',
    }),
    plan: makePlan({
      title: say(rl, {
        en: 'Trim the intro',
        hinglish: 'Intro trim karo',
        hi: 'इंट्रो ट्रिम करें',
      }),
      description: say(rl, {
        en: `Removes the first ${secs(second.start)} of the video.`,
        hinglish: `Video ke pehle ${secs(second.start)} hat jayenge.`,
        hi: `वीडियो के पहले ${secs(second.start)} हट जाएंगे।`,
      }),
      op,
      strip: stripFromCuts(ctx.tl, [[0, second.start]]),
      summary: [{ label: 'Saved', value: `${second.start.toFixed(1)}s`, tone: 'teal' }],
      focus: 0,
    }),
  }
}

const HELP_CHIPS = [
  'Add captions',
  'Remove filler words',
  'Find my best hook',
  'Make a 30 second Reel',
]

export function plan(rawPrompt: string, ctx: PlannerContext): PlannerResult {
  const rl = replyLang(rawPrompt, ctx.lang)
  const p = norm(rawPrompt)

  if (!p)
    return {
      text: say(rl, { en: 'Tell me what to do.', hinglish: 'Batao kya karna hai.' }),
      chips: HELP_CHIPS,
    }

  if (has(p, ['undo', 'wapas', 'pichla', 'revert', 'वापस', 'अनडू'])) {
    return {
      text: say(rl, {
        en: 'Undone. You can redo it with Shift plus Cmd or Ctrl plus Z.',
        hinglish: 'Undo kar diya. Redo ke liye Shift + Cmd/Ctrl + Z dabao.',
        hi: 'अनडू कर दिया।',
      }),
      action: 'undo',
    }
  }
  if (has(p, ['redo', 'dobara karo', 'phir se karo'])) {
    return {
      text: say(rl, { en: 'Redone.', hinglish: 'Redo kar diya.', hi: 'रीडू कर दिया।' }),
      action: 'redo',
    }
  }

  // Search: "where I talk about funding", "funding kahan hai", "find where ..."
  const about = p.match(/(?:talk about|about|baare mein|baare me|ke baare|kahan|where)\s+(.{3,})$/)
  if (
    (has(p, ['where', 'kahan', 'kahaan', 'कहां', 'कहाँ', 'find', 'dhundh', 'khoj', 'search']) &&
      about) ||
    /^(find|search|dhundho|dhundh)\s+(.+)/.test(p)
  ) {
    const q = (about?.[1] ?? p.replace(/^(find|search|dhundho|dhundh)\s+/, ''))
      .replace(/\b(hai|ho|kahan|where|i talk|mein|me)\b/g, '')
      .trim()
    if (q.length >= 2 && !has(p, ['hook', 'best', 'highlight'])) return searchReply(ctx, q, rl)
  }

  if (
    has(p, ['caption style', 'switch to', 'use ']) ||
    has(
      p,
      CAPTION_STYLES.map((s) => s.name.toLowerCase()),
    )
  ) {
    const hit = CAPTION_STYLES.find((s) => p.includes(s.name.toLowerCase()) || p.includes(s.id))
    if (
      hit &&
      has(p, [
        'caption',
        'style',
        'switch',
        'use',
        'lagao',
        'karaoke',
        'boxed',
        'neon',
        'minimal',
        'outline',
      ])
    ) {
      return captionStylePlan(ctx, hit.id, rl)
    }
  }

  if (has(p, ['filler', 'fillers', 'फिलर', 'umm', ' um ', ' uh ', 'matlab', 'basically', 'ahem']))
    return fillersPlan(ctx, rl)
  if (
    has(p, [
      'pause',
      'pauses',
      'silence',
      'silent',
      'dead air',
      'chup',
      'khamoshi',
      'पॉज़',
      'पॉज',
      'चुप',
      'सन्नाटा',
      'tighten',
      'tight kar',
    ])
  )
    return pausesPlan(ctx, rl)
  if (has(p, ['caption', 'captions', 'subtitle', 'subtitles', 'कैप्शन', 'सबटाइटल', 'text lagao']))
    return captionsPlan(ctx, rl)
  if (has(p, ['blur', 'dhundhla', 'ब्लर'])) return effectPlan(ctx, 'blur', rl)
  if (has(p, ['zoom', 'punch in', 'punch-in', 'close up', 'ज़ूम', 'जूम']))
    return effectPlan(ctx, 'zoom', rl)
  if (has(p, ['my style', 'apply style', 'meri style', 'mera style', 'मेरी स्टाइल', 'learn my']))
    return myStyle(ctx, rl)
  if (
    has(p, ['intro', 'shuru', 'beginning', 'इंट्रो']) &&
    has(p, ['trim', 'cut', 'hata', 'remove', 'skip', 'हटा'])
  )
    return trimIntro(ctx, rl)

  const wantsReel = has(p, ['reel', 'short', 'clip', 'रील', 'शॉर्ट', 'क्लिप', 'banao', 'make a'])
  if (
    has(p, [
      'hook',
      'best moment',
      'best part',
      'highlight',
      'viral',
      'sabse accha',
      'sabse achha',
      'सबसे अच्छा',
      'हुक',
    ]) &&
    !MINUTE.test(p) &&
    !SECONDS.test(p)
  ) {
    return bestHooks(ctx, rl)
  }
  if (wantsReel) {
    const s = p.match(SECONDS)
    const m = p.match(MINUTE)
    const len = s ? String(Math.min(180, Number(s[1]))) : m ? String(Number(m[1]) * 60) : undefined
    const style = has(p, ['fast', 'punchy', 'tez', 'तेज़'])
      ? 'fast'
      : has(p, ['natural', 'calm', 'slow'])
        ? 'calm'
        : undefined
    const part = has(p, ['best', 'hook', 'sabse'])
      ? 'best'
      : has(p, ['here', 'yahan', 'playhead', 'यहां'])
        ? 'here'
        : has(p, ['whole', 'poori', 'full'])
          ? 'all'
          : undefined
    if (part && len && style) return finishReel(ctx, rl, part, len, style)
    if (!part) return askPart(ctx, rl, len, style)
    if (!len) return askLength(rl, part, style)
    return askStyle(rl, part, len)
  }

  if (has(p, ['hi', 'hello', 'hey', 'namaste', 'namaskar', 'नमस्ते']) && p.split(' ').length <= 3) {
    return {
      text: say(rl, {
        en: `Hi! I am ${AI.name}. Tell me what to cut, find or fix.`,
        hinglish: `Namaste! Main ${AI.name} hoon. Batao kya cut, find ya fix karna hai.`,
        hi: `नमस्ते! मैं ${AI.name} हूं। बताइए क्या करना है।`,
      }),
      chips: HELP_CHIPS,
    }
  }
  if (has(p, ['thanks', 'thank you', 'shukriya', 'dhanyavad', 'धन्यवाद', 'शुक्रिया'])) {
    return {
      text: say(rl, {
        en: 'Anytime. Want captions next?',
        hinglish: 'Kabhi bhi. Ab captions lagayein?',
        hi: 'कभी भी। अब कैप्शन लगाएं?',
      }),
      chips: ['Add captions'],
    }
  }

  return {
    text: say(rl, {
      en: `I am not sure what you mean yet. I can remove fillers, trim pauses, add captions, find a moment, or build a Reel. Try one of these:`,
      hinglish: `Abhi poori tarah samajh nahi aaya. Main fillers hata sakta hoon, pauses trim kar sakta hoon, captions laga sakta hoon, koi moment dhundh sakta hoon, ya Reel bana sakta hoon. Inme se try karo:`,
      hi: `अभी पूरी तरह समझ नहीं आया। मैं फिलर हटा सकता हूं, पॉज़ ट्रिम कर सकता हूं, कैप्शन लगा सकता हूं या रील बना सकता हूं।`,
    }),
    chips: HELP_CHIPS,
  }
}

export function openingMessage(
  name: string,
  lang: Lang,
  title: string,
): { text: string; chips: string[] } {
  const first = name.split(' ')[0] ?? ''
  return {
    text: say(lang, {
      en: `Hi ${first}! I am ${AI.name}. I have read “${title}” and found moments worth posting. Tell me what to do, in Hindi, Hinglish or English.`,
      hinglish: `Namaste ${first}! Main ${AI.name} hoon. “${title}” padh li, aur kuch accha moments mile hain. Batao kya karna hai, Hindi, Hinglish ya English mein.`,
      hi: `नमस्ते ${first}! मैं ${AI.name} हूं। “${title}” देख ली है और अच्छे पल मिले हैं। बताइए क्या करना है।`,
    }),
    chips: HELP_CHIPS,
  }
}

export { pauseRanges, wordRange }
