import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeMedia } from '../../src/lib/ffprobe.js'
import { CancelledError, MediaError, run } from '../../src/media/ffmpeg.js'
import { buildScenes, detectCuts, detectSilences } from '../../src/media/scenes.js'
import {
  cutClip,
  extractAudio,
  keyframeTimes,
  makeProxy,
  makeThumbnail,
  onKeyframe,
} from '../../src/media/transform.js'
import { makeSceneVideo } from '../helpers/media.js'

let dir: string
let video: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lypcut-media-'))
  // Red 0-3, blue 3-7, green 7-12; a tone with a 2 second silence from 3 to 5; a keyframe every second.
  video = await makeSceneVideo({
    segments: [
      { color: 'red', seconds: 3 },
      { color: 'blue', seconds: 4 },
      { color: 'green', seconds: 5 },
    ],
    audio: [
      ['tone', 3],
      ['silence', 2],
      ['tone', 7],
    ],
  })
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const out = (name: string) => path.join(dir, name)

describe('detecting what is in a video', () => {
  it('finds the picture cuts', async () => {
    const cuts = await detectCuts(video)
    expect(cuts).toHaveLength(2)
    expect(cuts[0]!.time).toBeCloseTo(3, 0)
    expect(cuts[1]!.time).toBeCloseTo(7, 0)
    expect(cuts.every((c) => c.score > 0.3 && c.score <= 1)).toBe(true)
  })

  it('a higher threshold finds fewer cuts', async () => {
    expect(await detectCuts(video, { threshold: 0.999 })).toHaveLength(0)
  })

  it('finds the silence', async () => {
    const silences = await detectSilences(video)
    expect(silences).toHaveLength(1)
    expect(silences[0]!.start).toBeCloseTo(3, 0)
    expect(silences[0]!.end).toBeCloseTo(5, 0)
  })

  it('turns them into the right scenes', async () => {
    const scenes = buildScenes(await detectCuts(video), 12, await detectSilences(video))
    expect(scenes).toHaveLength(3)
    expect(scenes[0]!.end).toBeCloseTo(3, 0)
    expect(scenes[2]!.end).toBe(12)
  })

  it('finds the keyframes', async () => {
    const keys = await keyframeTimes(video)
    expect(keys.length).toBeGreaterThanOrEqual(11)
    expect(keys[0]).toBeCloseTo(0, 1)
    expect(onKeyframe(keys, 5)).toBe(true)
    expect(onKeyframe(keys, 5.5)).toBe(false)
  })
})

describe('cutting clips', () => {
  it('copies the streams when the cut starts on a keyframe, without re-encoding', async () => {
    const file = out('copy.mp4')
    await cutClip(video, file, 3, 7, 'copy')
    const info = await probeMedia(file)
    expect(info.durationSec).toBeGreaterThan(3.7)
    expect(info.durationSec).toBeLessThan(4.4)
    expect(info.videoCodec).toBe('h264')
    expect(info.hasAudio).toBe(true)
  })

  it('re-encodes when the start is not on a keyframe, and still starts where asked', async () => {
    const file = out('reencode.mp4')
    await cutClip(video, file, 4.5, 7, 'reencode')
    const info = await probeMedia(file)
    expect(info.durationSec).toBeGreaterThan(2.3)
    expect(info.durationSec).toBeLessThan(2.8)
  })
})

describe('the editing proxy', () => {
  it('is a small H.264 file with a keyframe every second and the voice track', async () => {
    const big = await makeSceneVideo({
      segments: [{ color: 'white', seconds: 6 }],
      audio: 'tone',
    })
    // Use a larger source so downscaling is visible.
    const hd = out('hd.mp4')
    await run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      hd,
    ])
    const proxy = out('proxy.mp4')
    await makeProxy(hd, proxy)

    const info = await probeMedia(proxy)
    expect(info.height).toBe(540)
    expect(info.width).toBe(960)
    expect(info.videoCodec).toBe('h264')
    expect(info.hasAudio).toBe(true)
    expect(info.durationSec).toBeGreaterThan(5.8)
    expect(fs.statSync(proxy).size).toBeLessThan(fs.statSync(hd).size)

    const keys = await keyframeTimes(proxy)
    expect(keys.length).toBeGreaterThanOrEqual(6)
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeLessThan(1.2)
    void big
  })

  it('never upscales a small video', async () => {
    const proxy = out('proxy-small.mp4')
    await makeProxy(video, proxy)
    expect((await probeMedia(proxy)).height).toBe(90)
  })

  it('reports progress while it works', async () => {
    const seen: number[] = []
    await makeProxy(video, out('proxy-progress.mp4'), { onProgress: (s) => seen.push(s) })
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeGreaterThan(10)
  })
})

describe('audio and thumbnails', () => {
  it('extracts mono 16 kHz WAV for transcription', async () => {
    const wav = out('audio.wav')
    await extractAudio(video, wav)
    const buf = fs.readFileSync(wav)
    expect(buf.subarray(0, 4).toString()).toBe('RIFF')
    expect(buf.readUInt16LE(22)).toBe(1) // channels
    expect(buf.readUInt32LE(24)).toBe(16000) // sample rate
    expect(buf.readUInt16LE(34)).toBe(16) // bits per sample
    expect(buf.length).toBeGreaterThan(16000 * 2 * 11)
  })

  it('fails clearly on a video with no audio track', async () => {
    const silent = await makeSceneVideo({ segments: [{ color: 'red', seconds: 3 }], audio: 'none' })
    await expect(extractAudio(silent, out('none.wav'))).rejects.toBeInstanceOf(MediaError)
  })

  it('makes a JPEG thumbnail', async () => {
    const jpg = out('thumb.jpg')
    await makeThumbnail(video, 5, jpg)
    const buf = fs.readFileSync(jpg)
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    expect(buf.length).toBeGreaterThan(200)
  })
})

describe('running FFmpeg safely', () => {
  it('can be cancelled, which stops the process', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const job = run(
      ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '600', '-f', 'null', '-'],
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 300)
    await expect(job).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run(['-version'], { signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    )
  })

  it('is killed when it overruns its timeout', async () => {
    const error = await run(
      ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '600', '-f', 'null', '-'],
      { timeoutMs: 400 },
    ).catch((e) => e)
    expect(error).toBeInstanceOf(MediaError)
    expect(error.message).toMatch(/timed out/)
  })

  it('reports why it failed, with FFmpeg’s own words', async () => {
    const error = await run(['-i', '/no/such/file.mp4', '-f', 'null', '-']).catch((e) => e)
    expect(error).toBeInstanceOf(MediaError)
    expect(error.message).toMatch(/No such file/i)
  })
})
