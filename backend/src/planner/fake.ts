import { readDataBlock } from '../llm/data-block.js'
import type { FakeAnswer, FakeHandler } from '../llm/index.js'
import { CAPTION_STYLES } from './caption-styles.js'
import { cannotYet, say } from './language.js'
import type { RL } from './types.js'

interface Data {
  replyLanguage: RL
  highlights: Array<{ id: string; hookScore: number }>
  sentences: Array<{ id: string }>
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,!?;:"“”()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const has = (text: string, words: string[]) => words.some((w) => text.includes(w))

const SECONDS = /(\d{1,3})\s*(?:sec|secs|second|seconds|s\b|सेकंड|सैकंड|सेकेंड)/
const MINUTE = /(\d{1,2})\s*(?:min|mins|minute|minutes|मिनट)/

const call = (name: string, input: unknown): FakeAnswer => ({
  text: '',
  toolCall: { id: `fake-${name}`, name, input },
})
const text = (t: string): FakeAnswer => ({ text: t })

/**
 * The offline model's rules for the assistant: the editor's own rule-based assistant, as a model that answers with the
 * same tool calls Claude would. It reads the same data block and the same tools, so everything after it (parsing, id
 * checks, the dry run, plan saving) is the real thing. It is simple on purpose: it recognises the requests the editor has
 * always understood, in English, Hinglish and Hindi, and answers the rest with what it can do.
 */
export const fakePlanner: FakeHandler = (req) => {
  const data = readDataBlock<Data>(req.context)
  const rl: RL = data?.replyLanguage ?? 'hinglish'
  const last = req.messages.at(-1)
  // Asked to correct itself: it has no better answer than the one it gave.
  if (last && typeof last.content !== 'string') return text(cannotYet(rl))
  const raw = typeof last?.content === 'string' ? last.content.split('\n').at(-1)! : ''
  const p = norm(raw)
  if (!p) return text(say(rl, { en: 'Tell me what to do.', hinglish: 'Batao kya karna hai.' }))

  if (has(p, ['undo', 'wapas', 'pichla', 'revert', 'वापस', 'अनडू'])) return call('undo', {})
  if (has(p, ['redo', 'dobara karo', 'phir se karo'])) return call('redo', {})

  // Where in the video: "where I talk about funding", "funding kahan hai", "find ..."
  const about = p.match(/(?:talk about|about|baare mein|baare me|ke baare|kahan|where)\s+(.{3,})$/)
  // "funding kahan hai": the thing comes first, the question word after it.
  const before = p.match(/^(.{3,}?)\s+(?:kahan|kahaan|कहां|कहाँ)(?:\s+(?:hai|ho|है))?$/)
  const finds =
    (has(p, ['where', 'kahan', 'kahaan', 'कहां', 'कहाँ', 'find', 'dhundh', 'khoj', 'search']) &&
      (about || before)) ||
    /^(find|search|dhundho|dhundh)\s+(.+)/.test(p)
  if (finds) {
    const q = (before?.[1] ?? about?.[1] ?? p.replace(/^(find|search|dhundho|dhundh)\s+/, ''))
      .replace(/\b(hai|ho|kahan|where|i talk|mein|me)\b/g, '')
      .trim()
    if (q.length >= 2 && !has(p, ['hook', 'best', 'highlight']))
      return call('find_moment', { query: q })
  }

  // Cutting sentences by number (counting from 1): "cut sentence 4 to 6"
  const cut = p.match(
    /(?:cut|kaat|kaato|hata|hatao|remove)\s+(?:sentence|sentences|line|lines|vakya)\s+(\d{1,4})(?:\s*(?:to|se|-|tak)\s*(\d{1,4}))?/,
  )
  // ...or the other way round, as Hinglish puts it: "sentence 2 se 5 tak hata do"
  const cutAfter = p.match(
    /(?:sentence|sentences|line|lines|vakya)\s+(\d{1,4})(?:\s*(?:to|se|-|tak)\s*(\d{1,4}))?\s*(?:tak\s+)?(?:cut|kaat|kaato|kaat do|hata|hatao|hata do|remove|delete)/,
  )
  const range = cut ?? cutAfter
  if (range) {
    const a = Number(range[1]) - 1
    const b = (range[2] ? Number(range[2]) : Number(range[1])) - 1
    return call('cut_range', {
      firstSentence: `s${Math.max(0, a)}`,
      lastSentence: `s${Math.max(0, b)}`,
    })
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
      return call('set_caption_style', { styleId: hit.id })
    }
  }

  if (has(p, ['filler', 'fillers', 'फिलर', 'umm', ' um ', ' uh ', 'matlab', 'basically', 'ahem']))
    return call('remove_fillers', {})
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
  ) {
    const m = raw.toLowerCase().match(/(\d(?:\.\d+)?)\s*(?:second|sec|s\b|सेकंड)/)
    return call('trim_pauses', m ? { maxPauseSec: Math.min(3, Math.max(0.3, Number(m[1]))) } : {})
  }
  if (has(p, ['caption', 'captions', 'subtitle', 'subtitles', 'कैप्शन', 'सबटाइटल', 'text lagao']))
    return call('add_captions', {})
  if (has(p, ['blur', 'dhundhla', 'ब्लर'])) return call('add_effect', { effect: 'blur' })
  if (has(p, ['zoom', 'punch in', 'punch-in', 'close up', 'ज़ूम', 'जूम']))
    return call('add_effect', { effect: 'zoom' })
  if (has(p, ['my style', 'apply style', 'meri style', 'mera style', 'मेरी स्टाइल', 'learn my'])) {
    return text(
      say(rl, {
        en: 'Matching your own style comes later. For now I can add captions in any of the caption styles.',
        hinglish:
          'Aapki apni style match karna baad mein aayega. Abhi main kisi bhi caption style mein captions laga sakta hoon.',
        hi: 'आपकी अपनी स्टाइल मैच करना बाद में आएगा। अभी मैं किसी भी कैप्शन स्टाइल में कैप्शन लगा सकता हूं।',
      }),
    )
  }
  if (
    has(p, ['intro', 'shuru', 'beginning', 'इंट्रो']) &&
    has(p, ['trim', 'cut', 'hata', 'remove', 'skip', 'हटा'])
  )
    return call('trim_intro', {})

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
    return call('best_hooks', {})
  }
  if (wantsReel) {
    const s = p.match(SECONDS)
    const m = p.match(MINUTE)
    const lengthSec = s
      ? Math.min(180, Number(s[1]))
      : m
        ? Math.min(180, Number(m[1]) * 60)
        : undefined
    const pace = has(p, ['fast', 'punchy', 'tez', 'तेज़'])
      ? 'fast'
      : has(p, ['natural', 'calm', 'slow'])
        ? 'calm'
        : undefined
    const best = [...(data?.highlights ?? [])].sort((a, b) => b.hookScore - a.hookScore)[0]
    const source = has(p, ['best', 'hook', 'sabse'])
      ? best
        ? { kind: 'highlight', id: best.id }
        : undefined
      : has(p, ['here', 'yahan', 'playhead', 'यहां'])
        ? { kind: 'playhead' }
        : has(p, ['whole', 'poori', 'full'])
          ? { kind: 'whole' }
          : undefined
    return call('make_reel', {
      ...(source ? { source } : {}),
      ...(lengthSec !== undefined ? { lengthSec } : {}),
      ...(pace ? { pace } : {}),
    })
  }

  if (has(p, ['hi', 'hello', 'hey', 'namaste', 'namaskar', 'नमस्ते']) && p.split(' ').length <= 3) {
    return text(
      say(rl, {
        en: 'Hi! I am Kaat. Tell me what to cut, find or fix.',
        hinglish: 'Namaste! Main Kaat hoon. Batao kya cut, find ya fix karna hai.',
        hi: 'नमस्ते! मैं काट हूं। बताइए क्या करना है।',
      }),
    )
  }
  if (has(p, ['thanks', 'thank you', 'shukriya', 'dhanyavad', 'धन्यवाद', 'शुक्रिया'])) {
    return text(
      say(rl, {
        en: 'Anytime. Want captions next?',
        hinglish: 'Kabhi bhi. Ab captions lagayein?',
        hi: 'कभी भी। अब कैप्शन लगाएं?',
      }),
    )
  }
  if (
    has(p, [
      'b-roll',
      'broll',
      'b roll',
      'color grade',
      'colour grade',
      'voice fix',
      '3d',
      'motion graphic',
      'generate',
    ])
  )
    return text(cannotYet(rl))

  return text(
    say(rl, {
      en: 'I am not sure what you mean yet. I can remove fillers, trim pauses, add captions, find a moment, or build a Reel. Try one of these:',
      hinglish:
        'Abhi poori tarah samajh nahi aaya. Main fillers hata sakta hoon, pauses trim kar sakta hoon, captions laga sakta hoon, koi moment dhundh sakta hoon, ya Reel bana sakta hoon. Inme se try karo:',
      hi: 'अभी पूरी तरह समझ नहीं आया। मैं फिलर हटा सकता हूं, पॉज़ ट्रिम कर सकता हूं, कैप्शन लगा सकता हूं या रील बना सकता हूं।',
    }),
  )
}
