import type { Outcome } from './metrics.js'

/**
 * What the assistant should do with a message. This is the contract the planner is measured against, in the three ways the
 * product's people write: English, Hinglish in Roman letters, and Hindi in Devanagari.
 *
 * `tool` is the tool the model should choose (any of a list is accepted where the request fits more than one), or `none`
 * when it should answer in words. `outcome` is what the person gets back. A request that depends on the video (a pause
 * threshold nothing in the talk reaches) may legitimately end as words instead of a plan, so it lists both.
 */
export interface GoldenCase {
  id: string
  text: string
  tool: string | string[]
  outcome: Outcome | Outcome[]
  /** Timeline seconds, for requests that act where the playhead is. */
  playhead?: number
  /** The request is answered by a fixed rule and must not reach the model at all. */
  noModel?: boolean
  /** Which script the reply should be in. Reported, not gated. */
  script?: 'devanagari' | 'latin'
}

export const GOLDEN: GoldenCase[] = [
  // English
  { id: 'en-fillers', text: 'Remove the filler words', tool: 'remove_fillers', outcome: 'plan' },
  {
    id: 'en-fillers-casual',
    text: 'can you take out the ums and matlabs',
    tool: 'remove_fillers',
    outcome: 'plan',
  },
  { id: 'en-pauses', text: 'Trim the long pauses', tool: 'trim_pauses', outcome: ['plan', 'text'] },
  {
    id: 'en-pauses-threshold',
    text: 'tighten any silence longer than 0.3 seconds',
    tool: 'trim_pauses',
    outcome: 'plan',
  },
  { id: 'en-captions', text: 'Add captions', tool: 'add_captions', outcome: 'plan' },
  { id: 'en-subtitles', text: 'put subtitles on the video', tool: 'add_captions', outcome: 'plan' },
  {
    id: 'en-captions-style',
    text: 'add karaoke style captions',
    tool: ['add_captions', 'set_caption_style'],
    outcome: 'plan',
  },
  {
    id: 'en-style',
    text: 'change the caption style to neon',
    tool: 'set_caption_style',
    outcome: 'plan',
  },
  { id: 'en-cut-range', text: 'cut sentence 3 to 4', tool: 'cut_range', outcome: 'plan' },
  {
    id: 'en-cut-topic',
    text: 'remove the part about the pitch deck',
    tool: 'cut_range',
    outcome: 'plan',
  },
  { id: 'en-intro', text: 'trim the intro', tool: 'trim_intro', outcome: 'plan' },
  { id: 'en-zoom', text: 'add a zoom here', tool: 'add_effect', outcome: 'plan', playhead: 12 },
  {
    id: 'en-blur',
    text: 'blur the background for 3 seconds',
    tool: 'add_effect',
    outcome: 'plan',
    playhead: 20,
  },
  { id: 'en-hooks', text: 'show me my best hooks', tool: 'best_hooks', outcome: ['plan', 'text'] },
  {
    id: 'en-find',
    text: 'where do I talk about funding',
    tool: 'find_moment',
    outcome: ['plan', 'text'],
  },
  {
    id: 'en-find-meaning',
    text: 'find the bit where I admit a mistake',
    tool: 'find_moment',
    outcome: ['plan', 'text'],
  },
  { id: 'en-reel', text: 'Make a Reel', tool: 'make_reel', outcome: 'question' },
  {
    id: 'en-reel-timed',
    text: 'make a 30 second reel from my best hook',
    tool: 'make_reel',
    outcome: ['question', 'plan'],
  },
  {
    id: 'en-reel-topic',
    text: 'turn the part about hiring into a short',
    tool: ['make_reel', 'find_moment'],
    outcome: ['question', 'plan'],
  },
  { id: 'en-undo', text: 'undo that', tool: 'undo', outcome: 'action' },
  { id: 'en-redo', text: 'redo', tool: 'redo', outcome: 'action' },
  { id: 'en-greeting', text: 'hello', tool: 'none', outcome: 'text' },
  { id: 'en-thanks', text: 'thanks!', tool: 'none', outcome: 'text' },
  {
    id: 'en-music',
    text: 'add some background music',
    tool: 'none',
    outcome: 'text',
    noModel: true,
  },
  {
    id: 'en-music-song',
    text: 'put a trending song under this',
    tool: 'none',
    outcome: 'text',
    noModel: true,
  },
  { id: 'en-unsupported', text: 'translate the video into French', tool: 'none', outcome: 'text' },
  { id: 'en-broll', text: 'add b-roll of a city skyline', tool: 'none', outcome: 'text' },
  { id: 'en-capabilities', text: 'what can you do?', tool: 'none', outcome: 'text' },
  {
    id: 'en-vague',
    text: 'make it better',
    tool: ['none', 'ask_question'],
    outcome: ['text', 'question'],
  },

  // Hinglish, in Roman letters
  { id: 'hi-fillers', text: 'filler words hatao', tool: 'remove_fillers', outcome: 'plan' },
  {
    id: 'hi-fillers-words',
    text: 'isme se um aur matlab hata do',
    tool: 'remove_fillers',
    outcome: 'plan',
  },
  { id: 'hi-pauses', text: 'pauses chhote karo', tool: 'trim_pauses', outcome: ['plan', 'text'] },
  {
    id: 'hi-pauses-threshold',
    text: 'jo pauses 0.3 second se lambe hain unhe kaat do',
    tool: 'trim_pauses',
    outcome: 'plan',
  },
  { id: 'hi-captions', text: 'captions lagao', tool: 'add_captions', outcome: 'plan' },
  {
    id: 'hi-subtitles',
    text: 'video mein subtitle daal do',
    tool: 'add_captions',
    outcome: 'plan',
  },
  { id: 'hi-style', text: 'caption style neon kar do', tool: 'set_caption_style', outcome: 'plan' },
  { id: 'hi-cut-range', text: 'sentence 2 se 5 tak hata do', tool: 'cut_range', outcome: 'plan' },
  { id: 'hi-intro', text: 'intro trim karo', tool: 'trim_intro', outcome: 'plan' },
  { id: 'hi-zoom', text: 'zoom lagao', tool: 'add_effect', outcome: 'plan', playhead: 12 },
  {
    id: 'hi-hooks',
    text: 'sabse achhe hooks dikhao',
    tool: 'best_hooks',
    outcome: ['plan', 'text'],
  },
  { id: 'hi-find', text: 'funding kahan hai', tool: 'find_moment', outcome: ['plan', 'text'] },
  {
    id: 'hi-find-topic',
    text: 'hiring ki baat kahan karta hoon main',
    tool: 'find_moment',
    outcome: ['plan', 'text'],
  },
  { id: 'hi-reel', text: 'ek Reel banao', tool: 'make_reel', outcome: 'question' },
  {
    id: 'hi-reel-timed',
    text: '30 second ka reel banao jo tez ho',
    tool: 'make_reel',
    outcome: ['question', 'plan'],
  },
  { id: 'hi-undo', text: 'wapas karo', tool: 'undo', outcome: 'action' },
  { id: 'hi-greeting', text: 'namaste', tool: 'none', outcome: 'text', script: 'latin' },
  { id: 'hi-music', text: 'music lagao', tool: 'none', outcome: 'text', noModel: true },

  // Hindi, in Devanagari
  {
    id: 'dev-fillers',
    text: 'फिलर वर्ड हटाओ',
    tool: 'remove_fillers',
    outcome: 'plan',
    script: 'devanagari',
  },
  {
    id: 'dev-pauses',
    text: 'लंबे पॉज़ हटाओ',
    tool: 'trim_pauses',
    outcome: ['plan', 'text'],
    script: 'devanagari',
  },
  {
    id: 'dev-captions',
    text: 'कैप्शन लगाओ',
    tool: 'add_captions',
    outcome: 'plan',
    script: 'devanagari',
  },
  {
    id: 'dev-reel',
    text: 'रील बनाओ',
    tool: 'make_reel',
    outcome: 'question',
    script: 'devanagari',
  },
  {
    id: 'dev-find',
    text: 'पिच डेक कहाँ है',
    tool: 'find_moment',
    outcome: ['plan', 'text'],
    script: 'devanagari',
  },
  {
    id: 'dev-hooks',
    text: 'सबसे अच्छा हुक दिखाओ',
    tool: 'best_hooks',
    outcome: ['plan', 'text'],
    script: 'devanagari',
  },
  { id: 'dev-undo', text: 'अनडू', tool: 'undo', outcome: 'action', script: 'devanagari' },
  {
    id: 'dev-capabilities',
    text: 'आप क्या कर सकते हो',
    tool: 'none',
    outcome: 'text',
    script: 'devanagari',
  },
]
