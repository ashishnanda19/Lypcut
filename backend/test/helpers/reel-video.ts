import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './media.js'

/** A tiny vertical video with known cuts and a known caption look, made with FFmpeg's own filters (no fonts, no text). */
export interface ReelSpec {
  seconds: number
  /** Times of picture cuts: the colour of the whole frame changes at each. */
  cuts?: number[]
  audio?: boolean
  /** `saffron-pop` draws a saffron pill and white "letters"; `plain` only white letters; `none` nothing. */
  look?: 'saffron-pop' | 'plain' | 'none'
}

const COLORS = ['0x303060', '0xb0b070', '0x603030', '0x30a0a0']

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    )
  })
}

const box = (x: number, y: number, w: number, h: number, color: string) =>
  `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`

function captionFilters(look: NonNullable<ReelSpec['look']>): string[] {
  if (look === 'none') return []
  const letters = Array.from({ length: 14 }, (_, i) => box(60 + i * 11, 360, 8, 15, '0xffffff'))
  return look === 'saffron-pop' ? [box(130, 354, 34, 28, '0xffa83a'), ...letters] : letters
}

/** Makes (or reuses) the video and returns its path. */
export async function makeReel(spec: ReelSpec): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash('sha1')
    .update(JSON.stringify({ v: 2, ...spec }))
    .digest('hex')
    .slice(0, 12)
  const file = path.join(CACHE_DIR, `reel-${key}.mp4`)
  if (fs.existsSync(file)) return file

  const edges = [0, ...(spec.cuts ?? []), spec.seconds]
  const flashes = edges
    .slice(0, -1)
    .map((from, i) =>
      i === 0
        ? null
        : `drawbox=x=0:y=0:w=270:h=480:color=${COLORS[i % COLORS.length]}:t=fill:enable='between(t,${from},${edges[i + 1]})'`,
    )
    .filter((f): f is string => f !== null)
  const filters = [...flashes, ...captionFilters(spec.look ?? 'none')].join(',')
  const tmp = `${file}.${process.pid}.tmp.mp4`
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${COLORS[0]}:s=270x480:r=10:d=${spec.seconds}`,
    ...(spec.audio === false
      ? []
      : ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${spec.seconds}`]),
    ...(filters ? ['-vf', filters] : []),
    '-t',
    String(spec.seconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(spec.audio === false ? [] : ['-c:a', 'aac', '-b:a', '32k']),
    '-movflags',
    '+faststart',
    tmp,
  ])
  fs.renameSync(tmp, file)
  return file
}

/** Words said at a steady pace, for a speech-recognition stand-in to report. */
export function wordsAt(start: number, count: number, perSecond: number, prefix = 'shabd') {
  return Array.from({ length: count }, (_, i) => ({
    text: `${prefix}${i}`,
    start: start + i / perSecond,
    end: start + (i + 0.8) / perSecond,
  }))
}
