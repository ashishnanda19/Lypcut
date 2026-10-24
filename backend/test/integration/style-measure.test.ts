import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { distance, fromHex } from '../../src/style/analysis/palette.js'
import { configureMedia } from '../../src/media/ffmpeg.js'
import { WorkDir } from '../../src/pipeline/workdir.js'
import {
  MAX_REEL_SEC,
  MeasureError,
  measureReel,
  jpegFrames,
} from '../../src/style/analysis/measure.js'
import { ScriptedProvider } from '../helpers/provider.js'
import { makeReel, wordsAt } from '../helpers/reel-video.js'
import { makeVideo } from '../helpers/media.js'

let work: WorkDir
beforeAll(() => {
  configureMedia({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  work = WorkDir.create(os.tmpdir(), `measure-${process.pid}`)
})
afterAll(() => work.destroy())

const speaking = (start: number, count: number, perSecond: number) =>
  new ScriptedProvider(() => ({ language: 'hi', words: wordsAt(start, count, perSecond) }))

const measure = (file: string, provider = speaking(2, 30, 3)) =>
  measureReel(file, {
    provider,
    language: 'hinglish',
    work,
    ffprobeBin: 'ffprobe',
    sceneThreshold: 0.3,
  })

describe('measuring a Reel from its file', () => {
  it('finds the cuts and scales them to cuts per ten seconds', async () => {
    const file = await makeReel({ seconds: 12, cuts: [4, 8], look: 'none' })
    const m = await measure(file)
    expect(m.durationSec).toBeCloseTo(12, 0)
    expect(m.cutCount).toBe(2)
    expect(m.cutPace).toBeCloseTo((2 / m.durationSec) * 10, 1)
    expect(m.cutPace).toBeCloseTo(1.67, 1)
  })

  it('a Reel with no cuts has a cut pace of 0', async () => {
    const m = await measure(await makeReel({ seconds: 10, look: 'none' }))
    expect(m.cutCount).toBe(0)
    expect(m.cutPace).toBe(0)
  })

  it('a faster-cut Reel has a higher pace', async () => {
    const slow = await measure(await makeReel({ seconds: 12, cuts: [6], look: 'none' }))
    const fast = await measure(
      await makeReel({ seconds: 12, cuts: [2, 4, 6, 8, 10], look: 'none' }),
    )
    expect(fast.cutPace).toBeGreaterThan(slow.cutPace * 2)
    expect(fast.cutCount).toBe(5)
  })

  it('hook timing is when the first word is spoken, when that comes before any strong cut', async () => {
    const file = await makeReel({ seconds: 12, cuts: [6], look: 'none' })
    const m = await measure(file, speaking(1.4, 20, 3))
    expect(m.hookTimingSec).toBeCloseTo(1.4, 1)
  })

  it('hook timing is the first strong picture change when it comes before the speech', async () => {
    const file = await makeReel({ seconds: 12, cuts: [1.5], look: 'none' })
    const m = await measure(file, speaking(5, 20, 3))
    expect(m.hookTimingSec).toBeGreaterThan(1.2)
    expect(m.hookTimingSec).toBeLessThan(1.9)
  })

  it('with no speech and no cut there is no hook timing, and no speech rate', async () => {
    const file = await makeReel({ seconds: 8, look: 'none', audio: false })
    const provider = speaking(0, 0, 1)
    const m = await measure(file, provider)
    expect(m.hookTimingSec).toBeNull()
    expect(m.speechRateWpm).toBeNull()
    expect(m.hasAudio).toBe(false)
    // No audio, so speech recognition is not even asked.
    expect(provider.calls).toBe(0)
  })

  it('speech rate is words per minute over the time the person was speaking', async () => {
    // 30 words, one every third of a second: about 10 seconds of speech, 180 words a minute.
    const m = await measure(await makeReel({ seconds: 14, look: 'none' }), speaking(2, 30, 3))
    expect(m.wordCount).toBe(30)
    expect(m.speechRateWpm).toBeGreaterThanOrEqual(170)
    expect(m.speechRateWpm).toBeLessThanOrEqual(190)
  })

  it('does not work out a speech rate from under three seconds of speech', async () => {
    const m = await measure(await makeReel({ seconds: 10, look: 'none' }), speaking(1, 4, 3))
    expect(m.speechRateWpm).toBeNull()
    expect(m.wordCount).toBe(4)
  })

  it('reads the caption look from the picture', async () => {
    const m = await measure(await makeReel({ seconds: 12, cuts: [4, 8], look: 'saffron-pop' }))
    expect(m.captions).toMatchObject({ status: 'matched', styleId: 'saffron-pop' })
    // The colour that was really on screen, after video compression: close to the editor's saffron.
    expect(distance(fromHex(m.captions.colors[0]!), fromHex('#ffa83a'))).toBeLessThan(12)
  })

  it('says there are no captions, and does not guess for plain white text', async () => {
    expect((await measure(await makeReel({ seconds: 10, look: 'none' }))).captions.status).toBe(
      'none',
    )
    expect((await measure(await makeReel({ seconds: 10, look: 'plain' }))).captions.status).toBe(
      'ambiguous',
    )
  })

  it('names a font from the script of the speech, and keeps no word of it', async () => {
    const deva = new ScriptedProvider(() => ({
      language: 'hi',
      words: wordsAt(1, 20, 3, 'फंडिंग'),
    }))
    const m = await measure(await makeReel({ seconds: 10, look: 'none' }), deva)
    expect(m.scriptFont).toBe('Noto Sans Devanagari')
    expect(JSON.stringify(m)).not.toContain('फंडिंग')
    expect(
      (await measure(await makeReel({ seconds: 10, look: 'none' }), speaking(1, 20, 3))).scriptFont,
    ).toBe('Inter')
  })

  it('refuses a Reel longer than 90 seconds, measured from the file and not from what was declared', async () => {
    const long = await makeVideo({ seconds: 95, audio: false })
    await expect(measure(long)).rejects.toMatchObject({ name: 'MeasureError', code: 'too_long' })
    expect(MAX_REEL_SEC).toBeGreaterThanOrEqual(90)
  })

  it('refuses a file that is not a video', async () => {
    const junk = path.join(work.dir, 'junk.mp4')
    fs.writeFileSync(junk, Buffer.from('this is not a video at all'.repeat(100)))
    await expect(measure(junk)).rejects.toBeInstanceOf(MeasureError)
    await expect(measure(junk)).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('makes small JPEGs of the same frames for a model to look at', async () => {
    const file = await makeReel({ seconds: 12, cuts: [4, 8], look: 'plain' })
    const m = await measure(file)
    const frames = await jpegFrames(file, m.frameTimes.slice(0, 3), work)
    expect(frames).toHaveLength(3)
    for (const f of frames) {
      expect(f[0]).toBe(0xff)
      expect(f[1]).toBe(0xd8)
      expect(f.length).toBeLessThan(60_000)
    }
  })
})
