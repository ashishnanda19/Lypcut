import { describe, expect, it } from 'vitest'
import { parseReelIntent, validAnswer } from '../../src/planner/intent.js'
import {
  asksForMusic,
  cleanPrompt,
  MAX_PROMPT_CHARS,
  musicReply,
  replyLang,
  say,
} from '../../src/planner/language.js'
import { conversation } from '../../src/planner/service.js'
import { parseToolCall, TOOLS, toolSchemas } from '../../src/planner/tools.js'

describe('what the person typed', () => {
  it('is cut to 1,000 characters', () => {
    expect(cleanPrompt('a'.repeat(5000))).toHaveLength(MAX_PROMPT_CHARS)
    expect(MAX_PROMPT_CHARS).toBe(1000)
  })

  it('loses control characters and invisible characters, but keeps tabs, newlines, Hindi and emoji', () => {
    const c = (...codes: number[]) => String.fromCharCode(...codes)
    const dirty = `fil${c(0)}ler${c(7)} hata${c(0x200b)}o${c(0x202e)} do${c(0x2060, 0xfeff, 0x85)}`
    expect(cleanPrompt(dirty)).toBe('filler hatao do')
    expect(cleanPrompt('कैप्शन\tलगाओ\n🙂 please')).toBe('कैप्शन लगाओ\n🙂 please')
  })

  it('squeezes spaces and blank lines and trims the ends', () => {
    expect(cleanPrompt('  a    b \n\n\n\nc  ')).toBe('a b\n\nc')
    expect(cleanPrompt('   ')).toBe('')
  })
})

describe('the language of the reply', () => {
  it('is Hindi for Devanagari, whatever the person’s setting', () => {
    expect(replyLang('फिलर हटाओ', 'en')).toBe('hi')
    expect(replyLang('captions लगाओ please', 'en')).toBe('hi')
  })

  it('is Hinglish for Roman letters with Hindi words in them, and English for plain English', () => {
    expect(replyLang('filler words hatao', 'en')).toBe('hinglish')
    expect(replyLang('mera reel banao 30 second ka', 'en')).toBe('hinglish')
    expect(replyLang('funding kahan hai', 'en')).toBe('hinglish')
    expect(replyLang('please remove the filler words', 'hinglish')).toBe('en')
    expect(replyLang('make a 30 second reel from my best hook', 'hinglish')).toBe('en')
    expect(replyLang('where I talk about funding', 'hinglish')).toBe('en')
  })

  it('falls back to the person’s own language when the words do not say (one word, a name)', () => {
    expect(replyLang('undo', 'en')).toBe('en')
    expect(replyLang('undo', 'hinglish')).toBe('hinglish')
    expect(replyLang('undo', 'hi')).toBe('hinglish')
    expect(replyLang('', 'en')).toBe('en')
  })

  it('picks the matching text, with Hinglish standing in for Hindi when there is no Hindi', () => {
    const s = { en: 'One', hinglish: 'Ek', hi: 'एक' }
    expect(say('en', s)).toBe('One')
    expect(say('hinglish', s)).toBe('Ek')
    expect(say('hi', s)).toBe('एक')
    expect(say('hi', { en: 'One', hinglish: 'Ek' })).toBe('Ek')
  })
})

describe('asking for music', () => {
  it.each([
    'add some background music',
    'background music lagao',
    'bgm daalo',
    'can you suggest a song for this',
    'koi gaana lagao',
    'कोई म्यूज़िक जोड़ दो',
    'music chahiye iske liye',
    'put a soundtrack under it',
    'find me royalty free music',
  ])('"%s" gets the music answer', (q) => {
    expect(asksForMusic(q)).toBe(true)
  })

  it.each([
    'find where I talk about music',
    'cut the part about the music industry',
    'remove filler words',
    'where do I mention songs',
    'captions lagao',
  ])('"%s" is not a request for music', (q) => {
    expect(asksForMusic(q)).toBe(false)
  })

  it('says they can add their own after export, in each language', () => {
    expect(musicReply('en')).toMatch(/your own music after you export/)
    expect(musicReply('hinglish')).toMatch(/apna music/)
    expect(musicReply('hi')).toMatch(/अपना म्यूज़िक/)
  })
})

describe('the tools', () => {
  it('are the whole list: twelve, each with a description', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'add_captions',
        'add_effect',
        'ask_question',
        'best_hooks',
        'cut_range',
        'find_moment',
        'make_reel',
        'redo',
        'remove_fillers',
        'set_caption_style',
        'trim_intro',
        'trim_pauses',
        'undo',
      ].sort(),
    )
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(10)
  })

  it('have no tool that touches music, files, the network or the database', () => {
    expect(TOOLS.map((t) => t.name).join(' ')).not.toMatch(
      /music|file|fetch|url|sql|delete|shell|run|read|write/i,
    )
  })

  it('accept valid arguments', () => {
    for (const [name, input] of [
      ['remove_fillers', {}],
      ['trim_pauses', { maxPauseSec: 0.5 }],
      ['add_captions', { styleId: 'karaoke' }],
      ['set_caption_style', { styleId: 'neon' }],
      ['make_reel', { source: { kind: 'highlight', id: 'hl_0' }, lengthSec: 30, pace: 'fast' }],
      ['make_reel', {}],
      ['find_moment', { query: 'funding' }],
      ['cut_range', { firstSentence: 's3', lastSentence: 's5' }],
      ['add_effect', { effect: 'zoom', lengthSec: 3 }],
      [
        'ask_question',
        {
          prompt: 'Which one?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', hint: 'x' },
          ],
        },
      ],
    ] as const) {
      expect(parseToolCall(name, input), name).toMatchObject({ ok: true })
    }
  })

  it('refuse an unknown tool, naming the ones that exist', () => {
    const r = parseToolCall('delete_project', {})
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toContain('remove_fillers')
  })

  it.each([
    ['an unknown field', 'remove_fillers', { sneaky: true }],
    ['a pause out of range', 'trim_pauses', { maxPauseSec: 99 }],
    ['an unknown caption style', 'set_caption_style', { styleId: 'comic-sans' }],
    ['a length out of range', 'make_reel', { lengthSec: 5000 }],
    ['an unknown source kind', 'make_reel', { source: { kind: 'file' } }],
    [
      'a sentence id that is not one',
      'cut_range',
      { firstSentence: '../etc/passwd', lastSentence: 's2' },
    ],
    [
      'a sentence id with SQL in it',
      'cut_range',
      { firstSentence: "s1'; drop table users;--", lastSentence: 's2' },
    ],
    ['a missing argument', 'cut_range', { firstSentence: 's1' }],
    ['an unknown effect', 'add_effect', { effect: 'explode' }],
    ['one option', 'ask_question', { prompt: 'x?', options: [{ id: 'a', label: 'A' }] }],
    [
      'five options',
      'ask_question',
      { prompt: 'x?', options: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id })) },
    ],
    [
      'an option id with spaces',
      'ask_question',
      {
        prompt: 'x?',
        options: [
          { id: 'a b', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
    ],
    ['a query that is too long', 'find_moment', { query: 'x'.repeat(500) }],
    ['a number where a string goes', 'find_moment', { query: 5 }],
  ] as const)('refuse %s', (_label, name, input) => {
    expect(parseToolCall(name, input)).toMatchObject({ ok: false })
  })

  it('treat a missing input as none, and refuse arguments a tool does not take', () => {
    expect(parseToolCall('undo', undefined)).toMatchObject({ ok: true })
    expect(parseToolCall('undo', { x: 1 })).toMatchObject({ ok: false })
  })

  it('do not accept inherited names as tools', () => {
    expect(parseToolCall('constructor', {})).toMatchObject({ ok: false })
    expect(parseToolCall('__proto__', {})).toMatchObject({ ok: false })
    expect(Object.keys(toolSchemas)).toHaveLength(13)
  })
})

describe('reading the intent of a Reel question that came back from the browser', () => {
  it('reads the questions the editor asks', () => {
    expect(parseReelIntent('reel|step=part')).toEqual({ step: 'part' })
    expect(parseReelIntent('reel|step=part|len=30|style=fast')).toEqual({
      step: 'part',
      len: '30',
      style: 'fast',
    })
    expect(parseReelIntent('reel|step=len|part=best')).toEqual({ step: 'len', part: 'best' })
    expect(parseReelIntent('reel|step=style|part=all|len=full')).toEqual({
      step: 'style',
      part: 'all',
      len: 'full',
    })
  })

  it.each([
    ['another kind', 'delete|step=part'],
    ['no step', 'reel|part=best'],
    ['an unknown step', 'reel|step=everything'],
    ['an unknown key', 'reel|step=part|admin=1'],
    ['a repeated key', 'reel|step=part|step=len'],
    ['a bad part', 'reel|step=len|part=../../x'],
    ['a bad style', 'reel|step=style|style=slowmo'],
    ['a length too long', 'reel|step=len|len=999'],
    ['a length too short', 'reel|step=len|len=1'],
    ['a length with letters', 'reel|step=len|len=3o'],
    ['a key without a value', 'reel|step'],
    ['an empty piece', 'reel||step=part'],
    ['an enormous string', `reel|step=part|${'x'.repeat(500)}`],
    ['nothing', ''],
  ])('refuses %s', (_label, intent) => {
    expect(parseReelIntent(intent)).toBeNull()
  })

  it('accepts only the options that belong to each step', () => {
    expect(validAnswer('part', 'best')).toBe(true)
    expect(validAnswer('part', '30')).toBe(false)
    expect(validAnswer('len', '30')).toBe(true)
    expect(validAnswer('len', 'full')).toBe(true)
    expect(validAnswer('len', 'best')).toBe(false)
    expect(validAnswer('len', '9000')).toBe(false)
    expect(validAnswer('style', 'fast')).toBe(true)
    expect(validAnswer('style', 'loud')).toBe(false)
  })
})

describe('the conversation the model sees', () => {
  it('starts and ends with the person, and keeps the order', () => {
    const m = conversation(
      [
        { from: 'ai', text: 'Hi, I am Kaat.' },
        { from: 'user', text: 'captions lagao' },
        { from: 'ai', text: 'Done.' },
      ],
      'ab fillers hatao',
    )
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(m.at(-1)).toEqual({ role: 'user', content: 'ab fillers hatao' })
  })

  it('keeps only the last 8 turns, merges turns of the same speaker, and cleans each one', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      from: (i % 2 ? 'ai' : 'user') as 'ai' | 'user',
      text: `turn ${i}\u0000`,
    }))
    const m = conversation(history, 'now')
    expect(JSON.stringify(m)).not.toContain('turn 11')
    expect(JSON.stringify(m)).toContain('turn 12')
    expect(JSON.stringify(m)).not.toContain('\\u0000')
    const roles = m.map((x) => x.role)
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
  })

  it('cuts a very long turn short', () => {
    const m = conversation([{ from: 'user', text: 'x'.repeat(5000) }], 'ok')
    expect((m[0]!.content as string).length).toBeLessThanOrEqual(1100)
  })

  it('is just the message when there is no history', () => {
    expect(conversation([], 'hello')).toEqual([{ role: 'user', content: 'hello' }])
  })
})
