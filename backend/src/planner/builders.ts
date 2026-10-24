import {
  applyOp,
  captionsForTimeline,
  coverage,
  keepRangeOp,
  removeFillersOp,
  splitByCoverage,
  timeAtSource,
  timelineDuration,
  trimPausesOp,
  type Timeline,
  type TimelineItem,
  type TimelineOp,
} from '@lypcut/timeline-core'
import { CAPTION_STYLE_IDS, CAPTION_STYLES, captionStyle } from './caption-styles.js'
import { say } from './language.js'
import { randomUUID } from 'node:crypto'
import type {
  BuiltResult,
  DraftPlan,
  SentenceLite,
  EditStripSegment,
  PlannerContext,
  QuestionCard,
  RL,
  StyleLite,
} from './types.js'

/**
 * The plan builders: what each thing the assistant can do becomes, as an op and as an Edit card (a title, a sentence,
 * a before and after strip, a few numbers). Ported from the editor's own assistant so the cards read the same, and
 * run on the shared engine. They do not call a model: the model only chooses which builder and with what, and
 * everything it names is looked up here, never taken on trust.
 */

/* -------------------------------- helpers -------------------------------- */

const secs = (n: number) => {
  const total = Math.max(0, Math.round(n))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** A small before/after strip for the Edit card: kept, cut and added stretches. */
export function stripFromCuts(tl: Timeline, cuts: Array<[number, number]>): EditStripSegment[] {
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

export function cutRanges(op: TimelineOp): Array<[number, number]> {
  if (op.type === 'cutSource') return [[op.srcFrom, op.srcTo]]
  if (op.type === 'batch') return op.ops.flatMap(cutRanges)
  return []
}

function firstCutTime(tl: Timeline, op: TimelineOp): number | undefined {
  const r = cutRanges(op).sort((a, b) => a[0] - b[0])[0]
  if (!r) return undefined
  return timeAtSource(tl, r[0])
}

const makePlan = (p: DraftPlan): DraftPlan => p

/* ------------------------------ plan builders ----------------------------- */

export function fillersPlan(ctx: PlannerContext, rl: RL): BuiltResult {
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

export function pausesPlan(ctx: PlannerContext, rl: RL, maxPauseSec = 0.7): BuiltResult {
  const minGap = Math.max(0.3, Math.min(3, maxPauseSec))
  const r = trimPausesOp(ctx.tl, ctx.tr.words, minGap, Math.min(0.3, minGap / 2))
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
      en: `${r.count} pauses are longer than ${minGap} seconds. I will shorten each to a natural beat, not remove it.`,
      hinglish: `${r.count} pauses ${minGap} second se lambe hain. Main unhe ek natural beat tak chhota karunga, poora nahi hataunga.`,
      hi: `${r.count} पॉज़ ${minGap} सेकंड से लंबे हैं। मैं इन्हें एक स्वाभाविक बीट तक छोटा करूंगा।`,
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

/** The creator's usual caption look: the first of their styles that the editor can apply (`custom` cannot be). */
export function profileStyleId(style: StyleLite | undefined): string | null {
  const known: readonly string[] = CAPTION_STYLE_IDS
  return style?.captionStyles.find((c) => known.includes(c.id))?.id ?? null
}

/**
 * Which caption look a plan uses. One the model chose for this request wins; otherwise the creator's own, when they have
 * asked for their style to be applied (the toggle, or by saying so); otherwise whatever the edit already has.
 */
export function resolveStyle(ctx: PlannerContext): { id: string; fromProfile: boolean } {
  if (ctx.styleId) return { id: ctx.styleId, fromProfile: false }
  const mine = ctx.applyStyle ? profileStyleId(ctx.style) : null
  return mine
    ? { id: mine, fromProfile: true }
    : { id: ctx.tl.settings.captionStyleId, fromProfile: false }
}

export const styleIdFor = (ctx: PlannerContext): string => resolveStyle(ctx).id

/** "Using your saffron-pop style." Said in the plan whenever the look came from the creator's profile. */
const usingYourStyle = (rl: RL, id: string) =>
  say(rl, {
    en: `Using your ${id} style.`,
    hinglish: `Aapki ${id} style use ho rahi hai.`,
    hi: `आपकी ${id} स्टाइल इस्तेमाल हो रही है।`,
  })

/** Said whenever the style comes from few Reels. Never left out. */
const fewReels = (rl: RL) =>
  say(rl, {
    en: 'Your style comes from only a few Reels, so treat it as a first guess. Add more Reels on the Style page for a sharper match.',
    hinglish:
      'Aapki style sirf kuch Reels se seekhi hai, isliye ise pehla andaza samjho. Style page par aur Reels jodo, match aur sahi hoga.',
    hi: 'आपकी स्टाइल सिर्फ कुछ रील्स से सीखी गई है, इसे पहला अंदाज़ा समझें। Style पेज पर और रील्स जोड़ें।',
  })

/** What to add to a plan's words, description and link when its look came from the creator's profile. */
function styleNotes(ctx: PlannerContext, rl: RL, id: string, fromProfile: boolean) {
  if (!fromProfile) return { text: '', description: '', route: undefined }
  const few = ctx.style?.confidence === 'low'
  return {
    text: few ? ` ${fewReels(rl)}` : '',
    description: ` ${usingYourStyle(rl, id)}${few ? ` ${fewReels(rl)}` : ''}`,
    route: few ? '/app/style' : undefined,
  }
}

export function captionsPlan(ctx: PlannerContext, rl: RL): BuiltResult {
  const items = captionsForTimeline(ctx.tl, ctx.tr.words)
  if (!items.length) {
    return {
      text: say(rl, {
        en: 'There is no speech left to caption.',
        hinglish: 'Caption ke liye speech bachi hi nahi.',
      }),
    }
  }
  const { id: sid, fromProfile } = resolveStyle(ctx)
  const note = styleNotes(ctx, rl, sid, fromProfile)
  const style = captionStyle(sid)
  const ops: TimelineOp[] = [{ type: 'addCaptions', items, replace: true }]
  if (sid !== ctx.tl.settings.captionStyleId || !ctx.tl.settings.captionsOn)
    ops.push({ type: 'setCaptionStyle', styleId: sid })
  const devanagari =
    ctx.tr.words.filter((w) => w.language === 'hi').length > ctx.tr.words.length / 2
  return {
    text:
      say(rl, {
        en: `Captions are ready: ${items.length} short phrases in the ${style.name} style. Hindi words stay in Devanagari.`,
        hinglish: `Captions ready hain: ${items.length} chhote phrases, ${style.name} style mein. Hindi words Devanagari mein dikhenge.`,
        hi: `कैप्शन तैयार हैं: ${items.length} छोटे वाक्यांश, ${style.name} स्टाइल में।`,
      }) + note.text,
    plan: makePlan({
      title: say(rl, { en: 'Add captions', hinglish: 'Captions lagao', hi: 'कैप्शन जोड़ें' }),
      description:
        say(rl, {
          en: `${items.length} phrases, ${style.name} style. Change the look any time in Properties.`,
          hinglish: `${items.length} phrases, ${style.name} style. Look kabhi bhi Properties mein badal sakte ho.`,
          hi: `${items.length} वाक्यांश, ${style.name} स्टाइल। लुक कभी भी बदल सकते हैं।`,
        }) + note.description,
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
    ...(note.route ? { route: note.route } : {}),
  }
}

export function captionStylePlan(
  ctx: PlannerContext,
  id: string,
  rl: RL,
  fromProfile = false,
): BuiltResult {
  const style = captionStyle(id)
  const note = styleNotes(ctx, rl, id, fromProfile)
  const hasCaps = Object.values(ctx.tl.items).some((i) => i.kind === 'caption')
  const ops: TimelineOp[] = []
  if (!hasCaps) {
    const items = captionsForTimeline(ctx.tl, ctx.tr.words)
    if (items.length) ops.push({ type: 'addCaptions', items, replace: true })
  }
  ops.push({ type: 'setCaptionStyle', styleId: id })
  return {
    text:
      say(rl, {
        en: `${style.name} it is. ${style.note}`,
        hinglish: `${style.name} style laga deta hoon. ${style.note}`,
        hi: `${style.name} स्टाइल लगा देता हूं।`,
      }) + note.text,
    plan: makePlan({
      title: say(rl, {
        en: `Use ${style.name} captions`,
        hinglish: `${style.name} captions lagao`,
        hi: `${style.name} कैप्शन लगाएं`,
      }),
      description: style.note + note.description,
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
    ...(note.route ? { route: note.route } : {}),
  }
}

/** Choose a window that starts on a sentence and ends on one, close to the target length. */
export function windowFor(
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
  /** Take out filler words. Defaults to `fast`. */
  fillers?: boolean
  /** Shorten pauses longer than this many seconds. Defaults to 0.7 when `fast`, and none otherwise. */
  pauseGapSec?: number
}

/** Build the "Make a Reel" edit: keep one range, optionally tighten it, add captions. */
export function reelPlan(ctx: PlannerContext, o: ReelOptions, rl: RL): BuiltResult {
  const cuts: TimelineOp[] = [keepRangeOp(o.srcFrom, o.srcTo, ctx.tl.sourceDuration)]
  let tl = applyOp(ctx.tl, cuts[0]!).timeline
  let fillerCount = 0
  let pauseCount = 0
  if (o.fillers ?? o.fast) {
    const f = removeFillersOp(tl, ctx.tr.words)
    if (f) {
      cuts.push(f.op)
      tl = applyOp(tl, f.op).timeline
      fillerCount = f.count
    }
  }
  const gap = o.pauseGapSec ?? (o.fast ? 0.7 : undefined)
  if (gap !== undefined) {
    const p = trimPausesOp(tl, ctx.tr.words, gap, Math.min(0.3, gap / 2))
    if (p) {
      cuts.push(p.op)
      tl = applyOp(tl, p.op).timeline
      pauseCount = p.count
    }
  }
  const caps = captionsForTimeline(tl, ctx.tr.words)
  const { id: sid, fromProfile } = resolveStyle(ctx)
  const note = styleNotes(ctx, rl, sid, fromProfile)
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
    description:
      say(rl, {
        en: `Keeps ${secs(o.srcFrom)} to ${secs(o.srcTo)}${o.fast ? ', removes fillers and long pauses' : ''}, then adds ${captionStyle(sid).name} captions.`,
        hinglish: `${secs(o.srcFrom)} se ${secs(o.srcTo)} rakhta hai${o.fast ? ', fillers aur lambe pauses hatata hai' : ''}, phir ${captionStyle(sid).name} captions lagata hai.`,
        hi: `${secs(o.srcFrom)} से ${secs(o.srcTo)} रखता है, फिर कैप्शन जोड़ता है।`,
      }) + note.description,
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
    text:
      say(rl, {
        en: `This Reel runs ${secs(length)} and starts on the hook. Preview it, then apply.`,
        hinglish: `Ye Reel ${secs(length)} ki hai aur seedha hook se shuru hoti hai. Preview dekho, phir apply karo.`,
        hi: `यह रील ${secs(length)} की है और सीधे हुक से शुरू होती है। प्रीव्यू देखें, फिर अप्लाई करें।`,
      }) + note.text,
    plan,
    chips: ['Blur the background', 'Switch to boxed captions'],
    ...(note.route ? { route: note.route } : {}),
  }
}

/* ------------------------------- match my style ------------------------------ */

/**
 * How tightly to shorten pauses for a creator who cuts this often (cuts per 10 seconds): the more often they cut, the
 * shorter a pause they will tolerate. Filler words come out for anyone who cuts at least every five seconds. These are the
 * only numbers that turn a profile into an edit, and they are here to be tuned.
 */
export const PACE_TABLE: Array<{ minCutPace: number; pauseGapSec: number; fillers: boolean }> = [
  { minCutPace: 4, pauseGapSec: 0.35, fillers: true },
  { minCutPace: 2.5, pauseGapSec: 0.5, fillers: true },
  { minCutPace: 1, pauseGapSec: 0.7, fillers: true },
  { minCutPace: 0, pauseGapSec: 1.0, fillers: false },
]

export const paceFor = (cutPace: number) =>
  PACE_TABLE.find((r) => cutPace >= r.minCutPace) ?? PACE_TABLE[PACE_TABLE.length - 1]!

/**
 * The highlight whose opening is closest to how the creator opens. The opening is the first sentence of the highlight, the
 * line that has to land the hook, and its length is compared with the creator's own time to the first word. Ties go to the
 * better hook; a creator with no timing (0) gets simply the best hook.
 */
export function closestHook(ctx: PlannerContext, hookTimingSec: number) {
  const opening = (h: { start: number; end: number }) => {
    const first = ctx.tr.sentences.find((s) => s.end > h.start + 0.01 && s.start < h.end)
    return first ? Math.min(first.end, h.end) - Math.max(first.start, h.start) : 0
  }
  const ranked = [...ctx.highlights].sort((a, b) =>
    hookTimingSec > 0
      ? Math.abs(opening(a) - hookTimingSec) - Math.abs(opening(b) - hookTimingSec) ||
        b.hookScore - a.hookScore ||
        a.id.localeCompare(b.id)
      : b.hookScore - a.hookScore || a.id.localeCompare(b.id),
  )
  return ranked[0]
}

/** What "match my style" says to someone with no profile yet. */
export function noStyleYet(rl: RL): BuiltResult {
  return {
    text: say(rl, {
      en: 'I can match your style once I have seen your Reels. Connect Instagram, or upload three to five Reels, on the Style page. It takes a minute.',
      hinglish:
        'Aapki style match karne ke liye pehle aapki Reels dekhni hongi. Style page par Instagram connect karo, ya 3 se 5 Reels upload karo.',
      hi: 'आपकी स्टाइल मैच करने के लिए पहले आपकी रील्स देखनी होंगी। Style पेज पर Instagram कनेक्ट करें, या 3 से 5 रील्स अपलोड करें।',
    }),
    route: '/app/style',
    chips: ['Add captions'],
  }
}

/**
 * "Match my style": one plan, all ordinary ops. A Reel from the highlight that opens the way this creator opens, with fillers
 * and pauses tightened to the pace they cut at, and captions in the look they use most. Built by code from the profile's
 * numbers; the model only chose to do it. With no profile it says how to get one.
 */
export function matchMyStylePlan(ctx: PlannerContext, rl: RL): BuiltResult {
  const style = ctx.style
  if (!style?.connected) return noStyleYet(rl)

  const look = profileStyleId(style)
  const pace = paceFor(style.cutPace)
  const hook = closestHook(ctx, style.hookTimingSec)
  // The profile was asked for by name, so it applies whatever the toggle says; the captions use its look if it has one.
  const mine: PlannerContext = { ...ctx, applyStyle: true, style }
  const built = hook
    ? reelPlan(
        mine,
        {
          srcFrom: hook.start,
          srcTo: hook.end,
          title: hook.title,
          fast: true,
          fillers: pace.fillers,
          pauseGapSec: pace.pauseGapSec,
          hookScore: hook.hookScore,
        },
        rl,
      )
    : captionsAndPace(mine, rl, look, pace)
  if (!built.plan) return built

  const lookName = look ? captionStyle(look).name : null
  const every = style.cutPace >= 0.5 ? (10 / style.cutPace).toFixed(1) : null
  const few = style.confidence === 'low'
  const title = say(rl, {
    en: 'Match my style',
    hinglish: 'Meri style lagao',
    hi: 'मेरी स्टाइल लगाएं',
  })
  const description =
    say(rl, {
      en: `${lookName ? `${lookName} captions` : 'Your current caption look'}, ${every ? `pauses tightened to your cut every ${every} seconds` : 'pauses left roomy, as you like them'}${hook ? `, from the part that opens the way yours do` : ''}.`,
      hinglish: `${lookName ? `${lookName} captions` : 'Abhi wala caption look'}, ${every ? `aapke har ${every} second ke cut ke hisaab se pauses tight` : 'pauses khule hue, jaise aapko pasand hain'}${hook ? `, wo hissa jo aapki tarah shuru hota hai` : ''}.`,
      hi: `${lookName ? `${lookName} कैप्शन` : 'अभी वाला कैप्शन लुक'}${every ? `, आपके हर ${every} सेकंड के कट के हिसाब से पॉज़ छोटे` : ''}।`,
    }) +
    (look ? ` ${usingYourStyle(rl, look)}` : '') +
    (few ? ` ${fewReels(rl)}` : '')
  const text =
    say(rl, {
      en: `Your top Reels use ${lookName ?? 'their own'} captions and cut roughly ${every ? `every ${every} seconds` : 'rarely'}. Here is that look.`,
      hinglish: `Aapki top Reels mein ${lookName ?? 'apne'} captions hain aur ${every ? `har ${every} second mein cut aata hai` : 'cut kam aata hai'}. Ye raha wahi look.`,
      hi: `आपकी टॉप रील्स में ${lookName ?? 'अपने'} कैप्शन हैं। यह रहा वही लुक।`,
    }) + (few ? ` ${fewReels(rl)}` : '')
  return {
    ...built,
    text,
    plan: {
      ...built.plan,
      title,
      description,
      summary: [
        ...(lookName ? [{ label: 'Captions', value: lookName, tone: 'saffron' as const }] : []),
        ...(every ? [{ label: 'Cut pace', value: `${every}s`, tone: 'teal' as const }] : []),
        ...built.plan.summary.filter((c) => c.label !== 'Style'),
      ],
    },
    ...(few ? { route: '/app/style' } : {}),
  }
}

/** With no highlight to build a Reel from: the current edit with the creator's captions and pace. */
function captionsAndPace(
  ctx: PlannerContext,
  rl: RL,
  look: string | null,
  pace: ReturnType<typeof paceFor>,
): BuiltResult {
  const ops: TimelineOp[] = []
  let tl = ctx.tl
  if (pace.fillers) {
    const f = removeFillersOp(tl, ctx.tr.words)
    if (f) {
      ops.push(f.op)
      tl = applyOp(tl, f.op).timeline
    }
  }
  const p = trimPausesOp(tl, ctx.tr.words, pace.pauseGapSec, Math.min(0.3, pace.pauseGapSec / 2))
  if (p) {
    ops.push(p.op)
    tl = applyOp(tl, p.op).timeline
  }
  const caps = captionsForTimeline(tl, ctx.tr.words)
  if (caps.length) ops.push({ type: 'addCaptions', items: caps, replace: true })
  if (look) ops.push({ type: 'setCaptionStyle', styleId: look })
  if (!ops.length) {
    return {
      text: say(rl, {
        en: 'Your edit already looks like your style.',
        hinglish: 'Aapka edit pehle se aapki style jaisa hai.',
        hi: 'आपका एडिट पहले से आपकी स्टाइल जैसा है।',
      }),
    }
  }
  return {
    text: '',
    plan: makePlan({
      title: '',
      description: '',
      op: { type: 'batch', ops, label: 'Match my style' },
      strip: stripFromCuts(ctx.tl, ops.flatMap(cutRanges)),
      summary: [],
      focus: 0,
    }),
  }
}

/* --------------------------------- questions -------------------------------- */

export function question(
  intent: string,
  prompt: string,
  options: Array<[string, string, string?]>,
): QuestionCard {
  return {
    id: `q_${randomUUID().slice(0, 8)}`,
    intent,
    prompt,
    options: options.map(([id, label, hint]) => ({ id, label, hint })),
  }
}

export const topHook = (ctx: PlannerContext) =>
  [...ctx.highlights].sort((a, b) => b.hookScore - a.hookScore)[0]

export function askPart(ctx: PlannerContext, rl: RL, len?: string, style?: string): BuiltResult {
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

export function askLength(rl: RL, part: string, style?: string): BuiltResult {
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

export function askStyle(rl: RL, part: string, len: string): BuiltResult {
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

export function finishReel(
  ctx: PlannerContext,
  rl: RL,
  part: string,
  len: string | undefined,
  style: string | undefined,
): BuiltResult {
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

export function nearestSource(ctx: PlannerContext): number {
  const items = Object.values(ctx.tl.items).filter((i): i is TimelineItem => i.kind === 'video')
  const it = items.find((i) => ctx.playhead >= i.start && ctx.playhead < i.start + i.duration)
  return it ? it.srcIn + (ctx.playhead - it.start) : 0
}

export function effectPlan(
  ctx: PlannerContext,
  kind: 'blur' | 'zoom',
  rl: RL,
  lengthSec?: number,
): BuiltResult {
  const track = ctx.tl.tracks.find((t) => t.kind === 'effects')
  const dur = Math.min(
    lengthSec ?? (kind === 'blur' ? 8 : 4),
    Math.max(1, timelineDuration(ctx.tl) - ctx.playhead),
  )
  const item: TimelineItem = {
    id: `fx_${ctx.planId.slice(-12)}`,
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

export function bestHooks(ctx: PlannerContext, rl: RL): BuiltResult {
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

export function trimIntro(ctx: PlannerContext, rl: RL): BuiltResult {
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

/** Cut from the first word of one sentence to the last word of another, and the pause that follows. */
export function cutRangePlan(
  ctx: PlannerContext,
  first: SentenceLite,
  last: SentenceLite,
  rl: RL,
): BuiltResult {
  const next = ctx.tr.sentences[last.idx + 1]
  const srcFrom = first.start
  const srcTo = next ? Math.max(last.end, next.start - 0.05) : last.end
  const op: TimelineOp = { type: 'cutSource', srcFrom, srcTo }
  const gone = splitByCoverage(ctx.tl, srcFrom, srcTo).covered.reduce((n, [a, b]) => n + (b - a), 0)
  if (gone < 0.05) {
    return {
      text: say(rl, {
        en: 'That part is already out of your edit.',
        hinglish: 'Wo hissa pehle se edit se bahar hai.',
        hi: 'वह हिस्सा पहले से एडिट से बाहर है।',
      }),
    }
  }
  const sentences = last.idx - first.idx + 1
  return {
    text: say(rl, {
      en: `I will cut ${secs(srcFrom)} to ${secs(srcTo)}, ${sentences} ${sentences === 1 ? 'sentence' : 'sentences'}. Preview it first if you like.`,
      hinglish: `${secs(srcFrom)} se ${secs(srcTo)} tak, ${sentences} sentence kaat deta hoon. Chaho to pehle preview dekh lo.`,
      hi: `${secs(srcFrom)} से ${secs(srcTo)} तक, ${sentences} वाक्य काट देता हूं। चाहें तो पहले प्रीव्यू देख लें।`,
    }),
    plan: makePlan({
      title: say(rl, {
        en: `Cut ${secs(srcFrom)} to ${secs(srcTo)}`,
        hinglish: `${secs(srcFrom)} se ${secs(srcTo)} kaato`,
        hi: `${secs(srcFrom)} से ${secs(srcTo)} काटें`,
      }),
      description: say(rl, {
        en: `Removes ${gone.toFixed(1)} seconds of speech and the pause after it.`,
        hinglish: `${gone.toFixed(1)} second ki speech aur uske baad ka pause hat jayega.`,
        hi: `${gone.toFixed(1)} सेकंड की बात और उसके बाद का पॉज़ हट जाएगा।`,
      }),
      op,
      strip: stripFromCuts(ctx.tl, [[srcFrom, srcTo]]),
      summary: [
        { label: 'Cuts', value: '1', tone: 'coral' },
        { label: 'Saved', value: `${gone.toFixed(1)}s`, tone: 'teal' },
      ],
      focus: timeAtSource(ctx.tl, srcFrom),
    }),
  }
}
