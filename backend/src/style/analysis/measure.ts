import fs from 'node:fs'
import type { Lang } from '../../modules/account/schema.js'
import { probeMedia } from '../../lib/ffprobe.js'
import { run, type RunOptions } from '../../media/ffmpeg.js'
import { detectCuts, type Cut } from '../../media/scenes.js'
import { extractAudio } from '../../media/transform.js'
import type { WorkDir } from '../../pipeline/workdir.js'
import type { TranscriptionProvider } from '../../transcription/types.js'
import { readCaptions, type CaptionRead, type Frame } from './captions.js'
import { MIN_SPEECH_SPAN_SEC, STRONG_CUT_SCORE } from './config.js'
import { fontFromScript, type EditorFont } from './fonts.js'

/** A Reel longer than this is refused, whatever the upload said: it is measured, not trusted. */
export const MAX_REEL_SEC = 90.5

/** Frames the caption rules look at, and their size. Stretched to this shape: the rules read colours and areas, not detail. */
const FRAMES = 6
const FRAME_W = 270
const FRAME_H = 480
/** Cuts this close to the start are the video starting, not a cut. */
const IGNORE_CUTS_BEFORE_SEC = 0.1

export type MeasureFailure = 'too_long' | 'unreadable' | 'no_video'

/** A Reel that cannot be measured, for a reason the person can act on. Not an outage: retrying will not help. */
export class MeasureError extends Error {
  constructor(
    readonly code: MeasureFailure,
    message: string,
  ) {
    super(message)
    this.name = 'MeasureError'
  }
}

/** Everything measured in one Reel. Numbers, ids and colours only: no frame, no word of the speech. */
export interface ReelMeasurement {
  durationSec: number
  hasAudio: boolean
  /** Picture cuts per ten seconds. */
  cutPace: number
  cutCount: number
  /** Seconds to the first spoken word or the first strong picture change, whichever is first. Null if neither. */
  hookTimingSec: number | null
  /** Words per minute over the time the person was speaking. Null with no speech, or under a few seconds of it. */
  speechRateWpm: number | null
  wordCount: number
  /** A font guess from the script of the speech, for when no model labels the captions. */
  scriptFont: EditorFont | null
  captions: CaptionRead
  /** Where in the Reel the caption frames were taken, so the same frames can be shown to a model. */
  frameTimes: number[]
}

export interface MeasureOptions {
  provider: TranscriptionProvider
  /** What the person says they speak: the recognition hint. */
  language: Lang
  work: WorkDir
  ffprobeBin: string
  sceneThreshold: number
  signal?: AbortSignal
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

/**
 * Measures a Reel from its file. Reuses what the pipeline already does: ffprobe for what the file is, the same scene
 * detector for cuts, the same audio extraction and speech recognition for the words. Picture and speech are measured; no
 * word of the speech is kept past this function, and what is on screen is read only as pixels.
 */
export async function measureReel(file: string, o: MeasureOptions): Promise<ReelMeasurement> {
  const runOpts: RunOptions = { signal: o.signal }
  let media
  try {
    media = await probeMedia(file, { bin: o.ffprobeBin })
  } catch (e) {
    if ((e as { status?: number }).status === 415)
      throw new MeasureError('unreadable', 'That file is not a video we can read.')
    throw e
  }
  if (media.durationSec > MAX_REEL_SEC)
    throw new MeasureError('too_long', 'A style Reel can be at most 90 seconds long.')

  const cuts = (await detectCuts(file, { ...runOpts, threshold: o.sceneThreshold })).filter(
    (c) => c.time >= IGNORE_CUTS_BEFORE_SEC,
  )
  const cutPace = round((cuts.length / media.durationSec) * 10, 2)

  let firstWord: number | null = null
  let lastWord: number | null = null
  let wordCount = 0
  let spoken = ''
  if (media.hasAudio) {
    const wav = o.work.file('reel-audio.wav')
    await extractAudio(file, wav, runOpts)
    const raw = await o.provider.transcribe(wav, { language: o.language, signal: o.signal })
    o.work.remove('reel-audio.wav')
    const words = raw.words.filter((w) => w.text.trim())
    wordCount = words.length
    if (words.length) {
      firstWord = Math.min(...words.map((w) => w.start))
      lastWord = Math.max(...words.map((w) => w.end))
      spoken = words.map((w) => w.text).join(' ')
    }
  }

  const span = firstWord !== null && lastWord !== null ? lastWord - firstWord : 0
  const strong = cuts.find((c) => c.score >= STRONG_CUT_SCORE)
  const hookCandidates = [firstWord, strong?.time].filter((t): t is number => t != null)

  const times = frameTimes(media.durationSec)
  const frames = await readFrames(file, times, o.work, runOpts)

  return {
    durationSec: round(media.durationSec, 2),
    hasAudio: media.hasAudio,
    cutPace,
    cutCount: cuts.length,
    hookTimingSec: hookCandidates.length ? round(Math.min(...hookCandidates), 2) : null,
    speechRateWpm: span >= MIN_SPEECH_SPAN_SEC ? Math.round((wordCount / span) * 60) : null,
    wordCount,
    scriptFont: fontFromScript(spoken),
    captions: readCaptions(frames),
    frameTimes: times,
  }
}

/** Evenly spread through the Reel, avoiding the very first and last instants. */
export function frameTimes(durationSec: number): number[] {
  return Array.from({ length: FRAMES }, (_, i) => round((durationSec * (i + 0.5)) / FRAMES, 2))
}

async function readFrames(
  file: string,
  times: number[],
  work: WorkDir,
  opts: RunOptions,
): Promise<Frame[]> {
  const frames: Frame[] = []
  for (const [i, t] of times.entries()) {
    const out = work.file(`frame-${i}.rgb`)
    try {
      await run(
        [
          '-ss',
          String(t),
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          `scale=${FRAME_W}:${FRAME_H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          out,
        ],
        opts,
      )
      const buf = fs.readFileSync(out)
      if (buf.length === FRAME_W * FRAME_H * 3)
        frames.push({
          width: FRAME_W,
          height: FRAME_H,
          rgb: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
        })
    } finally {
      work.remove(`frame-${i}.rgb`)
    }
  }
  return frames
}

/** JPEGs of the same frames, small, for a model to look at. Only made for Reels the rules could not place. */
export async function jpegFrames(
  file: string,
  times: number[],
  work: WorkDir,
  opts: RunOptions = {},
): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const [i, t] of times.entries()) {
    const path = work.file(`look-${i}.jpg`)
    try {
      await run(
        ['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', path],
        opts,
      )
      out.push(fs.readFileSync(path))
    } finally {
      work.remove(`look-${i}.jpg`)
    }
  }
  return out
}

export type { Cut }
