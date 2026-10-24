import type { Chapter, Highlight, Scene, Sentence, Speaker, Transcript, Word } from '@/types'
import { BANK } from './bank'

/**
 * Builds a believable transcript (word-level timing, speakers, fillers), highlights, chapters
 * and scenes from the script in bank.ts. Deterministic: the same inputs always give the same video.
 */

export interface GeneratedSource {
  transcript: Transcript
  highlights: Highlight[]
  chapters: Chapter[]
  scenes: Scene[]
  duration: number
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const SPEAKERS: Speaker[] = [
  { id: 'S1', name: 'Aarav (host)', color: 'saffron' },
  { id: 'S2', name: 'Meera (guest)', color: 'teal' },
]

function parseLine(text: string) {
  return text.split(' ').map((tok) => {
    const [roman, devRaw = ''] = tok.split('|')
    return {
      roman: roman!,
      dev: devRaw.replace(/[~@]/g, ''),
      filler: devRaw.includes('~'),
      english: devRaw.includes('@'),
    }
  })
}

export function generateSource(key: string, offset = 0, count = BANK.length): GeneratedSource {
  const words: Word[] = []
  const sentences: Sentence[] = []
  const lineStartSentence = new Map<number, number>() // bank line index -> sentence index
  const bankOf: number[] = []

  let t = 0.8
  let prevSpeaker = ''
  for (let n = 0; n < count; n++) {
    const bankIdx = (offset + n) % BANK.length
    const line = BANK[bankIdx]!
    const toks = parseLine(line.text)
    const from = words.length
    const gapSeed = hash(`${key}:${n}`)
    if (n > 0) {
      t += 0.35 + (gapSeed % 5) * 0.14 + (line.speaker !== prevSpeaker ? 0.35 : 0)
    }
    const sentenceStart = t
    for (const tok of toks) {
      const letters = tok.roman.replace(/[^a-zA-Z]/g, '').length
      let dur = Math.min(0.62, Math.max(0.24, 0.16 + 0.05 * letters))
      if (tok.filler) dur = Math.max(dur, 0.42)
      const start = t
      const end = t + dur
      words.push({
        text: tok.roman,
        dev: tok.dev,
        start: round(start),
        end: round(end),
        speaker: line.speaker,
        language: tok.english ? 'en' : 'hi',
        ...(tok.filler ? { filler: true } : {}),
      })
      t = end + 0.04 + (hash(`${key}:${n}:${words.length}`) % 6) * 0.012
      if (/[,.?!:]$/.test(tok.roman)) t += 0.08
    }
    sentences.push({
      id: `s${n}`,
      speaker: line.speaker,
      from,
      to: words.length,
      start: round(sentenceStart),
      end: words[words.length - 1]!.end,
    })
    lineStartSentence.set(bankIdx, n)
    bankOf.push(bankIdx)
    prevSpeaker = line.speaker
  }

  const duration = Math.ceil(t + 1.5)

  const highlights: Highlight[] = []
  const chapters: Chapter[] = []
  sentences.forEach((s, i) => {
    const line = BANK[bankOf[i]!]!
    if (line.hook) {
      const last = sentences[Math.min(sentences.length - 1, i + line.hook.lines - 1)]!
      highlights.push({
        id: `hl_${key}_${i}`,
        title: line.hook.title,
        start: round(Math.max(0, s.start - 0.2)),
        end: round(Math.min(duration, last.end + 0.4)),
        hookScore: line.hook.score,
        reason: line.hook.reason,
        thumbSeed: `${key}-hook-${i}`,
      })
    }
    if (line.chapter) {
      chapters.push({
        id: `ch_${key}_${i}`,
        title: line.chapter,
        start: round(Math.max(0, s.start - 0.4)),
        end: duration,
      })
    }
  })
  chapters.forEach((c, i) => {
    c.end = chapters[i + 1] ? chapters[i + 1]!.start : duration
  })
  if (chapters.length && chapters[0]!.start > 0) chapters[0]!.start = 0
  highlights.sort((a, b) => b.hookScore - a.hookScore)

  // Scenes: cut at sentence boundaries roughly every 20 to 35 seconds, and at chapter starts.
  const scenes: Scene[] = []
  let sceneStart = 0
  const chapterStarts = new Set(chapters.map((c) => c.start))
  sentences.forEach((s, i) => {
    const nextStart = sentences[i + 1]?.start
    if (nextStart === undefined) return
    const boundary = (s.end + nextStart) / 2
    const long = boundary - sceneStart >= 22 + (hash(`${key}:sc:${i}`) % 12)
    const atChapter = [...chapterStarts].some(
      (c) => Math.abs(c - (nextStart - 0.4)) < 0.05 && boundary - sceneStart > 8,
    )
    if (long || atChapter) {
      scenes.push(makeScene(scenes.length, sceneStart, round(boundary), chapters))
      sceneStart = round(boundary)
    }
  })
  scenes.push(makeScene(scenes.length, sceneStart, duration, chapters))

  return {
    transcript: { language: 'hinglish', speakers: SPEAKERS, words, sentences },
    highlights,
    chapters,
    scenes,
    duration,
  }
}

function makeScene(i: number, start: number, end: number, chapters: Chapter[]): Scene {
  const ch = chapters.find((c) => start >= c.start - 0.5 && start < c.end)
  return { id: `sc${i}`, label: ch ? `${ch.title}` : `Scene ${i + 1}`, start, end }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}
