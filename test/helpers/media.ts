import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Generated test media lives here (gitignored), so nothing large is ever committed. */
export const CACHE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')

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

export interface VideoSpec {
  seconds: number
  audio?: boolean
  /** Pad the file with a harmless trailing MP4 'free' box until it is at least this big. */
  padToBytes?: number
  size?: string
}

/** Makes (or reuses) a small real MP4: a test pattern, with a sine tone if audio is on. */
export async function makeVideo(spec: VideoSpec): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const { seconds, audio = true, padToBytes = 0, size = '160x90' } = spec
  const name = `v-${seconds}s-${audio ? 'av' : 'v'}-${size}-${padToBytes}.mp4`
  const file = path.join(CACHE_DIR, name)
  if (fs.existsSync(file)) return file

  const tmp = `${file}.${process.pid}.tmp.mp4`
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=2`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'] : []),
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-b:a', '32k'] : []),
    '-movflags',
    '+faststart',
    tmp,
  ])
  const have = fs.statSync(tmp).size
  if (padToBytes > have) {
    // A top-level 'free' box is skipped by every MP4 reader, so the file stays valid.
    const pad = padToBytes - have
    const header = Buffer.alloc(8)
    header.writeUInt32BE(pad, 0)
    header.write('free', 4, 'ascii')
    const fd = fs.openSync(tmp, 'a')
    fs.writeSync(fd, header)
    fs.writeSync(fd, Buffer.alloc(pad - 8))
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  return file
}

/** An audio-only MP4: valid media, but not a video. */
export async function makeAudioOnly(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, 'audio-only.mp4')
  if (!fs.existsSync(file)) {
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=16000',
      '-t',
      '3',
      '-c:a',
      'aac',
      file,
    ])
  }
  return file
}

export async function makePng(): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, 'not-a-video.png.mp4')
  if (!fs.existsSync(file)) {
    const tmp = path.join(CACHE_DIR, 'image.png')
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-frames:v', '1', tmp])
    fs.copyFileSync(tmp, file) // a PNG wearing an .mp4 name
  }
  return file
}

export function makeGarbage(bytes = 64 * 1024): string {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, `garbage-${bytes}.mp4`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(bytes))
  return file
}

export const sha256File = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
