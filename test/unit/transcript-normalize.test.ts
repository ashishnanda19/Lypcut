import { describe, expect, it } from 'vitest'
import { buildTranscript, foldForSearch } from '../../src/transcription/normalize.js'
import type { RawWord } from '../../src/transcription/types.js'

/** Words spaced evenly, 0.3 s each with a 0.05 s gap. */
function say(
  text: string,
  opts: { from?: number; speaker?: string; step?: number } = {},
): RawWord[] {
  let t = opts.from ?? 0
  const step = opts.step ?? 0.35
  return text.split(' ').map((w) => {
    const word: RawWord = { text: w, start: t, end: t + 0.3, speaker: opts.speaker }
    t += step
    return word
  })
}
const build = (words: RawWord[], hint?: 'hi' | 'hinglish' | 'en') =>
  buildTranscript({ words }, { hint })

describe('two scripts for every word', () => {
  it('turns Devanagari Hinglish into the Roman and Devanagari the editor shows', () => {
    // The first line of the front end's sample interview, as speech recognition would give it.
    const t = build(say('नमस्ते दोस्तों, आज का एपिसोड बहुत खास है।'))
    expect(t.words.map((w) => w.text)).toEqual([
      'namaste',
      'doston,',
      'aaj',
      'ka',
      'episode',
      'bahut',
      'khaas',
      'hai.',
    ])
    expect(t.words.map((w) => w.dev)).toEqual([
      'नमस्ते',
      'दोस्तों,',
      'आज',
      'का',
      'एपिसोड',
      'बहुत',
      'खास',
      'है।',
    ])
  })

  it('marks English words as English even when they are written in Devanagari', () => {
    const t = build(say('आज हम फंडिंग कैसे रेज़ करते हैं।'))
    const lang = Object.fromEntries(t.words.map((w) => [w.text, w.language]))
    expect(lang).toMatchObject({
      aaj: 'hi',
      hum: 'hi',
      funding: 'en',
      kaise: 'hi',
      raise: 'en',
      karte: 'hi',
    })
  })

  it('spells English loanwords the English way, not phonetically', () => {
    const t = build(say('इन्वेस्टर पिच डेक स्टार्टअप'))
    expect(t.words.map((w) => w.text)).toEqual(['investor', 'pitch', 'deck', 'startup'])
  })

  it('gives Roman Hinglish its Devanagari spelling where the lexicon knows the word', () => {
    const t = build(say('aaj hum funding kaise raise karte hain.'))
    expect(t.words.map((w) => w.dev)).toEqual([
      'आज',
      'हम',
      'फंडिंग',
      'कैसे',
      'रेज़',
      'करते',
      'हैं.',
    ])
    expect(t.words.map((w) => w.language)).toEqual(['hi', 'hi', 'en', 'hi', 'en', 'hi', 'hi'])
  })

  it('leaves an unknown Roman word in Roman in the Devanagari column rather than guessing', () => {
    const t = build(say('quarterly projections zindabad'))
    expect(t.words[0]!.dev).toBe('quarterly')
    expect(t.words[1]!.dev).toBe('projections')
  })

  it('treats a plain English transcript as English', () => {
    const t = build(say('Welcome back to the channel. Today we talk about hiring.'), 'en')
    expect(t.language).toBe('en')
    expect(t.words.every((w) => w.language === 'en' || w.text === 'the')).toBe(true)
  })

  it('keeps punctuation with its word in both columns, and a Devanagari danda becomes a full stop in Roman', () => {
    const t = build(say('यह सच है। “क्या” बात है?'))
    expect(t.words.map((w) => w.text)).toEqual(['yeh', 'sach', 'hai.', '“kya”', 'baat', 'hai?'])
    expect(t.words[2]!.dev).toBe('है।')
  })

  it('attaches a stray punctuation token to the word before it', () => {
    const t = build([
      { text: 'ठीक', start: 0, end: 0.3 },
      { text: '।', start: 0.3, end: 0.31 },
      { text: 'अच्छा', start: 0.5, end: 0.9 },
    ])
    expect(t.words.map((w) => w.text)).toEqual(['theek.', 'achha'])
  })

  it('numbers take the language of the word before them', () => {
    const t = build(say('चालीस लाख रुपये 40 lakh'))
    expect(t.words.find((w) => w.text === '40')!.language).toBe('hi')
  })
})

describe('search forms', () => {
  it('norm is lower case, accent-free, punctuation-free Roman, for both scripts', () => {
    const t = build(say('नमस्ते Funding, Café!'))
    expect(t.words.map((w) => w.norm)).toEqual(['namaste', 'funding', 'kafe'])
  })

  it('foldForSearch', () => {
    expect(foldForSearch('Café-Au-Lait!')).toBe('kafeaulait')
    expect(foldForSearch('फंडिंग')).toBe('फंडिंग')
    expect(foldForSearch("Don't")).toBe('dont')
  })
})

describe('spelling variants meet in the middle', () => {
  const key = (w: string) => foldForSearch(w)

  it('treats the spellings Whisper and people actually produce for one word as the same word', () => {
    // Real output from Whisper small on Hindi speech, beside what someone would type.
    expect(key('phunding')).toBe(key('funding'))
    expect(key('fundiing')).toBe(key('funding'))
    expect(key('bachchon')).toBe(key('bachon'))
    expect(key('zyada')).toBe(key('jyada'))
    expect(key('khaas')).toBe(key('khas'))
    expect(key('aaj')).toBe(key('aj'))
    expect(key('mushkil')).toBe(key('mushkeel'))
    expect(key('kitaab')).toBe(key('kitab'))
    expect(key('sooch')).toBe(key('such'))
    expect(key('wada')).toBe(key('vada'))
  })

  it('keeps genuinely different words apart', () => {
    expect(key('funding')).not.toBe(key('finding'))
    expect(key('baat')).not.toBe(key('bhaat'))
    expect(key('chor')).not.toBe(key('kor'))
    expect(key('hum')).not.toBe(key('hun'))
  })

  it('leaves digits alone', () => {
    expect(key('100')).toBe('100')
    expect(key('40')).toBe('40')
  })

  it('is the form stored for each word, so a search folded the same way finds it', () => {
    const t = build(say('फुंदिंग कैसे'))
    expect(t.words[0]!.norm).toBe(key('funding'))
  })
})

describe('fillers', () => {
  it('flags hesitations and filler words in either script', () => {
    const t = build(say('um अम matlab मतलब basically बेसिकली uh hmm'))
    expect(t.words.every((w) => w.filler)).toBe(true)
  })

  it('does not flag real words that merely look like one', () => {
    const t = build(say('umbrella ham matlabi hum'))
    expect(t.words.some((w) => w.filler)).toBe(false)
  })
})

describe('cleaning what the recogniser gives', () => {
  it('drops sound and music tags', () => {
    const t = build(say('[MUSIC] hello (laughs) world ♪ [BLANK_AUDIO]'))
    expect(t.words.map((w) => w.text)).toEqual(['hello', 'world'])
  })

  it('drops empty tokens and invisible characters', () => {
    const t = build([
      { text: '', start: 0, end: 0.1 },
      { text: '   ', start: 0.1, end: 0.2 },
      { text: '​hello‍', start: 0.3, end: 0.6 },
    ])
    expect(t.words.map((w) => w.text)).toEqual(['hello'])
  })

  it('makes timestamps move forward and every word last a moment', () => {
    const t = build([
      { text: 'one', start: 1, end: 1.5 },
      { text: 'two', start: 0.9, end: 1.4 }, // starts before the last one began
      { text: 'three', start: 2, end: 2 }, // zero length
      { text: 'four', start: Number.NaN, end: 3 }, // unusable
      { text: 'five', start: 2.5, end: 2.2 }, // ends before it starts
    ])
    expect(t.words.map((w) => w.text)).toEqual(['one', 'two', 'three', 'five'])
    for (let i = 0; i < t.words.length; i++) {
      const w = t.words[i]!
      expect(w.end).toBeGreaterThan(w.start)
      if (i > 0) expect(w.start).toBeGreaterThanOrEqual(t.words[i - 1]!.start)
    }
  })

  it('rounds times to the millisecond', () => {
    const t = build([{ text: 'hello', start: 1.23456789, end: 1.98765432 }])
    expect(t.words[0]).toMatchObject({ start: 1.235, end: 1.988 })
  })

  it('passes confidence through, and reports null when there is none', () => {
    const t = build([
      { text: 'a', start: 0, end: 0.2, confidence: 0.93 },
      { text: 'b', start: 0.3, end: 0.5 },
    ])
    expect(t.words.map((w) => w.confidence)).toEqual([0.93, null])
  })
})

describe('speakers', () => {
  it('numbers speakers in the order they first speak', () => {
    const t = build([
      ...say('hello there', { speaker: 'B' }),
      ...say('hi back', { from: 5, speaker: 'A' }),
      ...say('and again', { from: 10, speaker: 'B' }),
    ])
    expect(t.words.map((w) => w.speaker)).toEqual(['S1', 'S1', 'S2', 'S2', 'S1', 'S1'])
    expect(t.speakers).toEqual([
      { id: 'S1', name: 'Speaker 1', color: 'saffron' },
      { id: 'S2', name: 'Speaker 2', color: 'teal' },
    ])
  })

  it('without speaker labels everyone is Speaker 1', () => {
    const t = build(say('just one voice here'))
    expect(t.speakers).toEqual([{ id: 'S1', name: 'Speaker 1', color: 'saffron' }])
    expect(new Set(t.words.map((w) => w.speaker))).toEqual(new Set(['S1']))
  })

  it('colours alternate for three speakers', () => {
    const t = build([
      ...say('a b', { speaker: 'x' }),
      ...say('c d', { from: 3, speaker: 'y' }),
      ...say('e f', { from: 6, speaker: 'z' }),
    ])
    expect(t.speakers.map((s) => s.color)).toEqual(['saffron', 'teal', 'saffron'])
  })
})

describe('sentences', () => {
  const check = (t: ReturnType<typeof build>) => {
    // Every word is in exactly one sentence, in order, with no gaps.
    let next = 0
    for (const s of t.sentences) {
      expect(s.from).toBe(next)
      expect(s.to).toBeGreaterThan(s.from)
      expect(s.start).toBe(t.words[s.from]!.start)
      expect(s.end).toBe(t.words[s.to - 1]!.end)
      expect(s.text).toBe(
        t.words
          .slice(s.from, s.to)
          .map((w) => w.text)
          .join(' '),
      )
      next = s.to
    }
    expect(next).toBe(t.words.length)
    expect(t.sentences.map((s) => s.idx)).toEqual(t.sentences.map((_, i) => i))
  }

  it('splits at sentence-ending punctuation', () => {
    const t = build(say('namaste doston. aaj funding ki baat. kya aap ready hain?'))
    check(t)
    expect(t.sentences).toHaveLength(3)
    expect(t.sentences[0]!.text).toBe('namaste doston.')
  })

  it('splits at a long pause', () => {
    const t = build([...say('first part here'), ...say('second part here', { from: 5 })])
    check(t)
    expect(t.sentences).toHaveLength(2)
  })

  it('splits when the speaker changes', () => {
    const t = build([
      ...say('how are you', { speaker: 'A' }),
      ...say('i am fine', { from: 1.5, speaker: 'B' }),
    ])
    check(t)
    expect(t.sentences.map((s) => s.speaker)).toEqual(['S1', 'S2'])
  })

  it('never lets a run-on sentence grow without limit', () => {
    const t = buildTranscript(
      { words: say(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')) },
      { maxSentenceWords: 25 },
    )
    check(t)
    expect(Math.max(...t.sentences.map((s) => s.to - s.from))).toBeLessThanOrEqual(25)
  })

  it('carries both scripts and the search form on each sentence', () => {
    const t = build(say('आज फंडिंग की बात।'))
    expect(t.sentences[0]).toMatchObject({
      text: 'aaj funding ki baat.',
      dev: 'आज फंडिंग की बात।',
      norm: 'aj funding ki bat',
    })
  })
})

describe('which language is it', () => {
  it('Hindi with no English in it is Hindi', () => {
    expect(build(say('आज मैं आपको एक बहुत अच्छी कहानी सुनाऊँगा सुनो')).language).toBe('hi')
  })
  it('English is English', () => {
    expect(
      build(say('today i want to talk about how we raised our first round of money')).language,
    ).toBe('en')
  })
  it('a real mix is Hinglish', () => {
    expect(
      build(say('aaj hum funding raise karne ke baare mein baat karenge investors se')).language,
    ).toBe('hinglish')
  })
  it('with almost nothing said it trusts the hint', () => {
    expect(build(say('hello'), 'hi').language).toBe('hi')
    expect(build([], 'en').language).toBe('en')
    expect(build([]).language).toBe('hinglish')
  })
  it('an empty transcript is still well formed', () => {
    const t = build([])
    expect(t.words).toEqual([])
    expect(t.sentences).toEqual([])
    expect(t.speakers).toHaveLength(1)
  })
})

describe('scale', () => {
  it('handles a three hour transcript quickly', () => {
    const words = say(
      Array.from({ length: 30_000 }, (_, i) => (i % 3 ? 'baat' : 'funding')).join(' '),
      { step: 0.35 },
    )
    const started = Date.now()
    const t = build(words)
    expect(t.words).toHaveLength(30_000)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
