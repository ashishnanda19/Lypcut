import { beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '../../src/lib/errors.js'
import { probeMedia } from '../../src/lib/ffprobe.js'
import { makeAudioOnly, makeGarbage, makePng, makeVideo } from '../helpers/media.js'

describe('probeMedia', () => {
  let video: string
  beforeAll(async () => {
    video = await makeVideo({ seconds: 10 })
  })

  it('reads duration, size and codecs from a real video', async () => {
    const info = await probeMedia(video)
    expect(info.durationSec).toBeGreaterThan(9.5)
    expect(info.durationSec).toBeLessThan(10.5)
    expect(info).toMatchObject({ width: 160, height: 90, videoCodec: 'h264', hasAudio: true })
    expect(info.formatName).toContain('mp4')
    expect(info.fps).toBeCloseTo(2, 0)
  })

  it('reports a video with no audio track', async () => {
    const silent = await makeVideo({ seconds: 4, audio: false })
    const info = await probeMedia(silent)
    expect(info.hasAudio).toBe(false)
    expect(info.audioCodec).toBeNull()
  })

  it('refuses things that are not videos, whatever they are named', async () => {
    for (const file of [makeGarbage(), await makePng(), await makeAudioOnly()]) {
      const error = await probeMedia(file).catch((e) => e)
      expect(error, file).toBeInstanceOf(AppError)
      expect(error).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA' })
    }
  })

  it('refuses a file that does not exist as unsupported media, not as a crash', async () => {
    const error = await probeMedia('/nonexistent/file.mp4').catch((e) => e)
    expect(error).toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
  })

  it('reports a missing ffprobe as a server fault, not a bad upload', async () => {
    const error = await probeMedia(video, { bin: 'definitely-not-ffprobe' }).catch((e) => e)
    expect(error).not.toBeInstanceOf(AppError)
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  it('gives up on a probe that takes too long', async () => {
    const error = await probeMedia(video, { timeoutMs: 1 }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
  })
})
