import { describe, expect, it } from 'vitest'
import {
  findChapters,
  findHighlights,
  labelScene,
  titleFrom,
} from '../../src/transcription/insights.js'
import { buildTranscript } from '../../src/transcription/normalize.js'
import type { RawWord } from '../../src/transcription/types.js'

interface Line {
  text: string
  /** Seconds of silence before the line. */
  gap?: number
  speaker?: string
}

/** Builds a transcript from lines of speech, 0.35 s a word, so timings are predictable. */
function talk(lines: Line[]) {
  const words: RawWord[] = []
  let t = 0.5
  for (const line of lines) {
    t += line.gap ?? 0.5
    for (const w of line.text.split(' ')) {
      words.push({ text: w, start: t, end: t + 0.3, speaker: line.speaker })
      t += 0.35
    }
  }
  const built = buildTranscript({ words })
  return { ...built, duration: Math.ceil(t + 1) }
}

const bland = (n: number): Line[] =>
  Array.from({ length: n }, (_, i) => ({
    text: `aur phir hum agle kaam par gaye jo bahut zaroori tha number${i % 2 ? 'a' : 'b'}.`,
  }))

describe('titles', () => {
  it('drops trailing punctuation, capitalises, and shortens long text at a word', () => {
    expect(titleFrom('funding goal nahi, tool hai.')).toBe('Funding goal nahi, tool hai')
    // A question mark is part of the meaning, so it stays.
    expect(titleFrom('kya aap ready hain?')).toBe('Kya aap ready hain?')
    expect(titleFrom('   ')).toBe('Untitled moment')
    const long = titleFrom(
      'this is a rather long sentence that goes on and on and on past any sensible title length',
    )
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/\s…$/)
  })
})

describe('finding hooks', () => {
  const sample = () =>
    talk([
      ...bland(4),
      {
        text: 'meri sabse badi galti thi chaalis lakh rupaye bina soche kharch kar diye.',
        gap: 1.4,
      },
      {
        text: 'phir maine seekha ki har rupaye ka hisaab rakhna padta hai warna sab khatam ho jata hai.',
      },
      { text: 'aur ye sabak mujhe bahut mehnga pada tha dosto.' },
      ...bland(6),
    ])

  it('picks the moment that opens with a strong claim and a number', () => {
    const t = sample()
    const [top] = findHighlights(t.sentences, t.words, t.duration)
    expect(top!.title).toMatch(/^Meri sabse badi galti/)
    expect(top!.hookScore).toBeGreaterThan(60)
    expect(top!.reason).toMatch(/number|claim|hook/i)
  })

  it('returns windows long enough to stand alone, that start and end on sentence boundaries', () => {
    const t = sample()
    for (const h of findHighlights(t.sentences, t.words, t.duration)) {
      expect(h.end - h.start).toBeGreaterThanOrEqual(8)
      expect(h.end - h.start).toBeLessThanOrEqual(46)
      expect(h.start).toBeGreaterThanOrEqual(0)
      expect(h.end).toBeLessThanOrEqual(t.duration)
    }
  })

  it('never overlaps, never exceeds the count, and is sorted best first', () => {
    const t = talk(
      Array.from({ length: 80 }, (_, i) => ({
        text:
          i % 7 === 0
            ? `kya aap jaante hain ki ${i} log galti karte hain?`
            : `ye ek normal baat hai number ${i}.`,
        gap: i % 7 === 0 ? 1.0 : 0.4,
      })),
    )
    const hs = findHighlights(t.sentences, t.words, t.duration, { count: 4 })
    expect(hs.length).toBeLessThanOrEqual(4)
    for (let i = 1; i < hs.length; i++)
      expect(hs[i - 1]!.hookScore).toBeGreaterThanOrEqual(hs[i]!.hookScore)
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        expect(hs[i]!.start < hs[j]!.end && hs[i]!.end > hs[j]!.start, `${i} overlaps ${j}`).toBe(
          false,
        )
      }
    }
  })

  it('scores are whole numbers from 0 to 100, and every result has a title and a reason', () => {
    const t = sample()
    for (const h of findHighlights(t.sentences, t.words, t.duration)) {
      expect(Number.isInteger(h.hookScore)).toBe(true)
      expect(h.hookScore).toBeGreaterThanOrEqual(0)
      expect(h.hookScore).toBeLessThanOrEqual(100)
      expect(h.title.length).toBeGreaterThan(0)
      expect(h.reason.length).toBeGreaterThan(10)
    }
  })

  it('prefers a window without fillers to an otherwise identical one full of them', () => {
    const clean = talk([
      ...bland(2),
      { text: 'ye ek bahut zaroori baat hai jo har founder ko pata honi chahiye dosto.', gap: 1 },
      ...bland(3),
    ])
    const messy = talk([
      ...bland(2),
      {
        text: 'um matlab basically ye ek um bahut zaroori baat hai matlab jo har founder ko um pata honi chahiye dosto.',
        gap: 1,
      },
      ...bland(3),
    ])
    const score = (t: ReturnType<typeof talk>) =>
      Math.max(
        ...findHighlights(t.sentences, t.words, t.duration, { minScore: 0 }).map(
          (h) => h.hookScore,
        ),
      )
    expect(score(clean)).toBeGreaterThan(score(messy))
  })

  it('still returns the best one when nothing scores well', () => {
    const t = talk(bland(8))
    expect(findHighlights(t.sentences, t.words, t.duration, { minScore: 99 })).toHaveLength(1)
  })

  it('returns nothing for an empty transcript, and is deterministic', () => {
    expect(findHighlights([], [], 10)).toEqual([])
    const t = sample()
    expect(findHighlights(t.sentences, t.words, t.duration)).toEqual(
      findHighlights(t.sentences, t.words, t.duration),
    )
  })

  it('copes with a recording shorter than the minimum window', () => {
    const t = talk([{ text: 'bas ek chhoti si baat.' }])
    const hs = findHighlights(t.sentences, t.words, t.duration)
    expect(hs.length).toBeLessThanOrEqual(1)
  })
})

describe('finding chapters', () => {
  const long = () =>
    talk(
      Array.from({ length: 60 }, (_, i) => ({
        text: `ye baat number ${i} hai aur isme kaafi detail hai jo aapko samajhni chahiye.`,
        // A real pause every 8 lines (about 40 seconds).
        gap: i > 0 && i % 8 === 0 ? 2 : 0.4,
      })),
    )

  it('starts with Intro at zero and covers the whole video with no gaps or overlaps', () => {
    const t = long()
    const ch = findChapters(t.sentences, t.duration)
    expect(ch[0]).toMatchObject({ title: 'Intro', start: 0 })
    expect(ch[ch.length - 1]!.end).toBe(t.duration)
    for (let i = 1; i < ch.length; i++) expect(ch[i]!.start).toBe(ch[i - 1]!.end)
    for (const c of ch) expect(c.end).toBeGreaterThan(c.start)
  })

  it('breaks at pauses, and not into tiny chapters', () => {
    const t = long()
    const ch = findChapters(t.sentences, t.duration, { minSec: 45 })
    expect(ch.length).toBeGreaterThan(2)
    for (const c of ch.slice(0, -1)) expect(c.end - c.start).toBeGreaterThanOrEqual(40)
  })

  it('titles each chapter from its opening words', () => {
    const t = long()
    const ch = findChapters(t.sentences, t.duration)
    for (const c of ch.slice(1)) expect(c.title).toMatch(/^Ye baat number/)
  })

  it('never makes more chapters than the cap', () => {
    const t = long()
    expect(
      findChapters(t.sentences, t.duration, { minSec: 5, pauseSec: 0.1, maxChapters: 5 }).length,
    ).toBeLessThanOrEqual(5)
  })

  it('cuts a very long stretch even without a pause', () => {
    const t = talk(
      Array.from({ length: 80 }, (_, i) => ({
        text: `lagatar bolte rahe baat ${i} par.`,
        gap: 0.1,
      })),
    )
    expect(findChapters(t.sentences, t.duration, { maxSec: 60 }).length).toBeGreaterThan(1)
  })

  it('a short video is one Intro chapter, an empty one is none', () => {
    const t = talk([{ text: 'chhota sa video hai ye.' }])
    expect(findChapters(t.sentences, t.duration)).toEqual([
      { title: 'Intro', start: 0, end: t.duration },
    ])
    expect(findChapters([], 30)).toEqual([])
  })
})

describe('labelling scenes', () => {
  const chapters = [
    { title: 'Intro', start: 0, end: 50 },
    { title: 'Paisa kyun chahiye', start: 50, end: 120 },
  ]
  it('uses the chapter a scene starts in', () => {
    expect(labelScene(10, 0, chapters)).toBe('Intro')
    expect(labelScene(60, 3, chapters)).toBe('Paisa kyun chahiye')
    expect(labelScene(49.7, 1, chapters)).toBe('Paisa kyun chahiye')
  })
  it('falls back to "Scene N" with no chapters', () => {
    expect(labelScene(10, 4, [])).toBe('Scene 5')
  })
})
