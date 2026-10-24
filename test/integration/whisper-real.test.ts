import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { projects, transcriptWords, transcripts } from '../../src/db/schema/index.js'
import { buildTranscript } from '../../src/transcription/normalize.js'
import { WhisperCppProvider } from '../../src/transcription/providers/whisper-cpp.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeSpeech, makeVideoWithAudio } from '../helpers/media.js'
import { startProcessing, tmpRoot, waitForJob } from '../helpers/pipeline.js'
import { fullUpload } from '../helpers/upload.js'
import { signup } from '../helpers/world.js'

/**
 * The real thing: whisper.cpp, a real model, and real (synthesised) speech. It runs where all three exist and
 * is skipped everywhere else, so a laptop with the model downloaded checks Hindi and Hinglish for real while
 * CI and Docker builds stay fast and offline.
 *
 *   build:  cmake whisper.cpp, then point WHISPER_BIN at whisper-cli    (see README)
 *   model:  npm run models:download
 *   voices: macOS only (Lekha speaks Hindi, Aman speaks English)
 */
const root = path.resolve(import.meta.dirname, '../..')
const BIN = process.env.WHISPER_BIN ?? path.join(root, '.tools/whisper.cpp/build/bin/whisper-cli')
const MODEL = process.env.WHISPER_MODEL_PATH ?? path.join(root, 'models/ggml-small.bin')

const HINDI =
  'नमस्ते दोस्तों, आज हम बात करेंगे कि फंडिंग कैसे रेज़ करते हैं। मेरी सबसे बड़ी गलती थी चालीस लाख रुपये बिना सोचे खर्च कर दिए।'
const ENGLISH =
  'Today I want to talk about how we raised our first round of funding from investors. My biggest mistake was spending money without thinking.'

const hindi = makeSpeech('hindi', 'Lekha', HINDI)
const english = makeSpeech('english', 'Aman', ENGLISH)
const available = fs.existsSync(BIN) && fs.existsSync(MODEL) && hindi !== null && english !== null

const provider = () => new WhisperCppProvider({ bin: BIN, modelPath: MODEL, threads: 4 })

describe.skipIf(!available)('real Whisper', () => {
  it('hears Hindi, in Devanagari, with word timings that fit the clip', async () => {
    const raw = await provider().transcribe(hindi!, { language: 'hinglish' })
    expect(raw.words.length).toBeGreaterThanOrEqual(12)
    expect(raw.words.some((w) => /[ऀ-ॿ]/.test(w.text))).toBe(true)
    for (const [i, w] of raw.words.entries()) {
      expect(w.end, `word ${i}`).toBeGreaterThanOrEqual(w.start)
      expect(w.end).toBeLessThan(12)
      if (i > 0) expect(w.start).toBeGreaterThanOrEqual(raw.words[i - 1]!.start)
    }
  }, 120_000)

  it('turns real Hindi into both scripts, and finds ordinary words in the Roman form', async () => {
    const raw = await provider().transcribe(hindi!, { language: 'hinglish' })
    const t = buildTranscript(raw, { hint: 'hinglish' })
    expect(['hi', 'hinglish']).toContain(t.language)
    const roman = t.words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ''))
    // Whisper small misspells some words; the everyday ones it gets right.
    const heard = ['aaj', 'hum', 'baat', 'kaise', 'karte', 'hain', 'bina', 'meri'].filter((w) =>
      roman.includes(w),
    )
    expect(heard.length, roman.join(' ')).toBeGreaterThanOrEqual(4)
    expect(t.words.every((w) => w.dev.length > 0 && w.norm.length > 0)).toBe(true)
    expect(t.sentences.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('hears English and marks every word as English', async () => {
    const raw = await provider().transcribe(english!, { language: 'en' })
    const t = buildTranscript(raw, { hint: 'en' })
    expect(t.language).toBe('en')
    const heard = t.words.map((w) => w.norm)
    expect(heard).toEqual(expect.arrayContaining(['funding', 'investors']))
    expect(t.words.filter((w) => w.language === 'en').length).toBeGreaterThan(t.words.length * 0.9)
  }, 120_000)

  it('reports progress', async () => {
    const seen: number[] = []
    await provider().transcribe(hindi!, { language: 'hinglish', onProgress: (f) => seen.push(f) })
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBe(1)
  }, 120_000)
})

describe.skipIf(!available)('a spoken Hindi video through the whole pipeline', () => {
  let t: TestApp
  let tmp: string
  beforeAll(async () => {
    tmp = tmpRoot()
    t = await createTestApp({ TMP_DIR: tmp, JOB_ATTEMPTS: '1' })
  })
  afterAll(async () => {
    await t.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await resetDatabase(t.deps.database)
    await t.deps.redis.flushdb()
    await t.deps.storage.deletePrefix('users/')
  })

  it('goes from an uploaded video to a project with a real Hinglish transcript', async () => {
    const video = await makeVideoWithAudio(hindi!, 'hindi')
    const { c } = await signup(t)
    const { projectId, done } = await fullUpload(c, video)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    const jobId = done.body.job.id as string

    const worker = startProcessing(t.deps, provider())
    try {
      await waitForJob(t.deps, jobId, 'done', 180_000)
    } finally {
      await worker.close()
    }

    const { db } = t.deps.database
    const [tr] = await db.select().from(transcripts).where(eq(transcripts.projectId, projectId))
    expect(tr).toMatchObject({ provider: 'whisper-local', model: 'small' })
    expect(['hi', 'hinglish']).toContain(tr!.language)
    const words = await db
      .select()
      .from(transcriptWords)
      .where(eq(transcriptWords.projectId, projectId))
    expect(words.length).toBeGreaterThanOrEqual(12)
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]!.status).toBe(
      'ready',
    )
  }, 240_000)
})
