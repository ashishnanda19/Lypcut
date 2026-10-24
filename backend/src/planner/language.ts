import type { Lang, RL, Say } from './types.js'

const DEVANAGARI = /[ऀ-ॿ]/

/** Hindi written in Roman letters: common words that English does not use. Enough to tell Hinglish from English. */
const HINGLISH = new Set(
  (
    'hai hain hoga hogi tha thi kya kyun kyon kaise kab kahan kahaan kaun kitna kitni mein ka ki ke ko se par pe aur ya ' +
    'nahi nahin mat bas abhi ab phir bhi toh lekin magar isse usse iska uska mera meri mere tera teri aap tum main hum yeh ye wo woh ' +
    'karo kar karna kardo kijiye karein hatao hata dena dijiye lagao laga lagana banao bana dikhao dikha batao bata ' +
    'chhota chhote chhoti kaato kaat kaatna dhundho dhundh sabse accha achha bahut thoda zyada jyada kam pehle baad wala wali wale ' +
    'chahiye chahta chahti sakta sakte gaana jaldi tez dhire seedha ji haan'
  ).split(' '),
)
/** Common English words, so a short plain-English request is not taken for Hinglish. */
const ENGLISH = new Set(
  (
    'the a an please remove add find make show cut trim where what how why when who which my me i you your it this that these those ' +
    'from with for of to in on at and or but not is are was were be do does did can could would should will want need like just some ' +
    'any all more less best top first last next video clip reel captions caption filler fillers pauses pause part about talk ' +
    'sentence sentences start end intro blur zoom style give set switch change use thanks thank'
  ).split(' '),
)

/**
 * The language a reply is written in. Devanagari in the message means Hindi. In Roman letters a message is Hinglish if it
 * uses Hindi words, English if it is made of English words and nothing else, and otherwise (one word like "undo") it is
 * the person's own language.
 */
export function replyLang(prompt: string, lang: Lang): RL {
  if (DEVANAGARI.test(prompt)) return 'hi'
  const words = prompt.toLowerCase().match(/[a-z]+/g) ?? []
  const hindi = words.filter((w) => HINGLISH.has(w)).length
  const english = words.filter((w) => ENGLISH.has(w)).length
  if (hindi > 0 && hindi >= english - 1) return 'hinglish'
  if (english > 0 && hindi === 0) return 'en'
  return lang === 'hi' ? 'hinglish' : lang
}

export const say = (rl: RL, s: Say): string =>
  rl === 'hi' ? (s.hi ?? s.hinglish) : rl === 'hinglish' ? s.hinglish : s.en

/** What a person types goes to a model and into a log-free pipeline: bound its size and drop what is not text. */
export const MAX_PROMPT_CHARS = 1000

/** Control characters (other than tab and newline) and the invisible characters used to hide text inside a message. */
function isHidden(cp: number): boolean {
  if (cp === 9 || cp === 10 || cp === 13) return false
  return (
    cp < 32 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff
  )
}

export function cleanPrompt(raw: string): string {
  return Array.from(raw)
    .filter((ch) => !isHidden(ch.codePointAt(0)!))
    .join('')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_PROMPT_CHARS)
}

// Music only comes up as a request when someone wants it added or suggested; "find where I talk about music" is
// an ordinary search of what was said.
const MUSIC_WORD =
  '(?:music|musics|song|songs|bgm|soundtrack|background track|jingle|beat|gaana|gaane|gana|sangeet|संगीत|गाना|गाने|म्यूज़िक|म्यूजिक|मयूजिक)'
const ADD_WORD =
  '(?:add|put|insert|include|mix|lagao|laga|lagana|daal|daalo|dalo|dal do|chahiye|chaahiye|suggest|recommend|find me|source|download|royalty|copyright free|जोड़|डाल|लगा|चाहिए|सुझा)'
const MUSIC = new RegExp(
  `${ADD_WORD}[^.?!]{0,60}${MUSIC_WORD}|${MUSIC_WORD}[^.?!]{0,60}${ADD_WORD}|background music|bgm`,
  'iu',
)

/** Asking for music to be added: the answer is always the same, and it needs no model. */
export const asksForMusic = (prompt: string): boolean => MUSIC.test(prompt)

export const musicReply = (rl: RL): string =>
  say(rl, {
    en: 'I do not add music. You can add your own music after you export. I can still cut, caption and shape the video, so tell me what to do with it.',
    hinglish:
      'Main music nahi lagata. Export karne ke baad aap apna music daal sakte ho. Cut, captions aur shape mein main madad kar sakta hoon, batao kya karna hai.',
    hi: 'मैं म्यूज़िक नहीं जोड़ता। एक्सपोर्ट के बाद आप अपना म्यूज़िक जोड़ सकते हैं। कट, कैप्शन और वीडियो को शेप देने में मैं मदद कर सकता हूं।',
  })

/** The things the assistant cannot do yet, so it can say so plainly instead of guessing. */
export const cannotYet = (rl: RL): string =>
  say(rl, {
    en: 'I cannot do that yet. I can remove fillers, trim pauses, add captions, find a moment, cut a part, add a blur or a zoom, or build a Reel.',
    hinglish:
      'Ye abhi mujhse nahi hoga. Main fillers hata sakta hoon, pauses trim kar sakta hoon, captions laga sakta hoon, moment dhundh sakta hoon, hissa kaat sakta hoon, blur ya zoom laga sakta hoon, ya Reel bana sakta hoon.',
    hi: 'यह अभी मुझसे नहीं होगा। मैं फिलर हटा सकता हूं, पॉज़ ट्रिम कर सकता हूं, कैप्शन लगा सकता हूं, पल ढूंढ सकता हूं, हिस्सा काट सकता हूं, ब्लर या ज़ूम लगा सकता हूं या रील बना सकता हूं।',
  })

export const failedReply = (rl: RL, why: 'slow' | 'could_not'): string =>
  why === 'slow'
    ? say(rl, {
        en: 'That took too long. Please try again.',
        hinglish: 'Isme bahut time lag gaya. Please dobara try karo.',
        hi: 'इसमें बहुत समय लग गया। कृपया दोबारा कोशिश करें।',
      })
    : say(rl, {
        en: 'I could not turn that into an edit that works on this video. Try saying it another way, or one step at a time.',
        hinglish:
          'Isse is video par chalne wala edit nahi ban paya. Doosre tarike se kaho, ya ek-ek step mein.',
        hi: 'इसे इस वीडियो पर चलने वाला एडिट नहीं बना पाया। दूसरे तरीके से कहें, या एक-एक कदम में।',
      })

export const HELP_CHIPS = [
  'Add captions',
  'Remove filler words',
  'Find my best hook',
  'Make a 30 second Reel',
]
