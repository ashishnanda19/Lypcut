import { run, type RunOptions } from './ffmpeg.js'

/** Keyframe times (seconds) of the first video stream. Reads packet headers only, so it is fast. */
export async function keyframeTimes(input: string, opts: RunOptions = {}): Promise<number[]> {
  const { stdout } = await run(
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      input,
    ],
    { ...opts, tool: 'ffprobe', collectStdout: true },
  )
  return parseKeyframes(stdout)
}

/** Lines look like "12.480000,K__" (a keyframe has K in its flags). */
export function parseKeyframes(text: string): number[] {
  const out: number[] = []
  for (const line of text.split('\n')) {
    const [t, flags] = line.trim().split(',')
    if (flags?.startsWith('K') && t && t !== 'N/A') out.push(Number(t))
  }
  return out.sort((a, b) => a - b)
}

/** How far a scene's start may be from a keyframe and still be cut without re-encoding. */
export const KEYFRAME_TOLERANCE_SEC = 0.04

export function onKeyframe(keyframes: number[], t: number): boolean {
  if (t <= KEYFRAME_TOLERANCE_SEC) return true
  // Binary search for the nearest keyframe.
  let lo = 0
  let hi = keyframes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid]! < t) lo = mid + 1
    else hi = mid
  }
  const near = [keyframes[lo], keyframes[lo - 1]].filter((k): k is number => k !== undefined)
  return near.some((k) => Math.abs(k - t) <= KEYFRAME_TOLERANCE_SEC)
}

export type CutMode = 'copy' | 'reencode'

/**
 * Cuts [start, end) out of `input`. When the start is on a keyframe the streams are copied untouched
 * (instant, lossless). Otherwise that one clip is re-encoded so it still starts exactly where the scene does.
 */
export async function cutClip(
  input: string,
  output: string,
  start: number,
  end: number,
  mode: CutMode,
  opts: RunOptions = {},
): Promise<void> {
  const duration = end - start
  if (mode === 'copy') {
    await run(
      [
        '-ss',
        start.toFixed(3),
        '-i',
        input,
        '-t',
        duration.toFixed(3),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        output,
      ],
      opts,
    )
    return
  }
  await run(
    [
      '-ss',
      start.toFixed(3),
      '-i',
      input,
      '-t',
      duration.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      output,
    ],
    opts,
  )
}

/**
 * One lightweight stand-in for the whole video, for smooth scrubbing in the editor: at most 540p H.264
 * with a keyframe every second (so a seek lands within a second) and the voice track. No HLS or DASH.
 */
export async function makeProxy(
  input: string,
  output: string,
  opts: RunOptions = {},
): Promise<void> {
  await run(
    [
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=-2:'min(540,ih)'",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '27',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      output,
    ],
    opts,
  )
}

/** Mono 16 kHz 16-bit WAV: what speech recognition wants. */
export async function extractAudio(
  input: string,
  output: string,
  opts: RunOptions = {},
): Promise<void> {
  await run(
    ['-i', input, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    opts,
  )
}

/** A small JPEG of the frame at `at` seconds. */
export async function makeThumbnail(
  input: string,
  at: number,
  output: string,
  opts: RunOptions = {},
): Promise<void> {
  await run(
    [
      '-ss',
      at.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=480:-2',
      '-q:v',
      '4',
      output,
    ],
    opts,
  )
}
