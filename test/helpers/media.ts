import { spawn, spawnSync } from 'node:child_process'
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

export interface SceneVideoSpec {
  /** Each segment is a flat colour, so every boundary is an unmistakable picture cut. */
  segments: Array<{ color: string; seconds: number }>
  /** Audio: a tone throughout, or tone/silence runs in seconds, for example [['tone',3],['silence',2],['tone',3]]. */
  audio?: 'tone' | 'none' | Array<['tone' | 'silence', number]>
  /** Keyframe every this many seconds. */
  keyframeEverySec?: number
  fps?: number
}

/** A video with known picture cuts, known silences and known keyframes, for testing the media code. */
export async function makeSceneVideo(spec: SceneVideoSpec): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const { segments, audio = 'tone', keyframeEverySec = 1, fps = 10 } = spec
  const key = createHash('sha1')
    .update(JSON.stringify({ segments, audio, keyframeEverySec, fps }))
    .digest('hex')
    .slice(0, 12)
  const file = path.join(CACHE_DIR, `scenes-${key}.mp4`)
  if (fs.existsSync(file)) return file

  const total = segments.reduce((s, x) => s + x.seconds, 0)
  const inputs: string[] = []
  segments.forEach((s) =>
    inputs.push('-f', 'lavfi', '-i', `color=c=${s.color}:s=160x90:d=${s.seconds}:r=${fps}`),
  )
  const videoGraph = `${segments.map((_, i) => `[${i}:v]`).join('')}concat=n=${segments.length}:v=1:a=0[v]`

  const audioInputs: string[] = []
  let audioGraph = ''
  let audioMap: string[] = []
  if (audio !== 'none') {
    const runs: Array<['tone' | 'silence', number]> = audio === 'tone' ? [['tone', total]] : audio
    const base = segments.length
    runs.forEach(([kind, secs]) =>
      audioInputs.push(
        '-f',
        'lavfi',
        '-i',
        kind === 'tone'
          ? `sine=frequency=440:sample_rate=16000:duration=${secs}`
          : `anullsrc=r=16000:cl=mono,atrim=duration=${secs}`,
      ),
    )
    audioGraph = `;${runs.map((_, i) => `[${base + i}:a]`).join('')}concat=n=${runs.length}:v=0:a=1[a]`
    audioMap = ['-map', '[a]', '-c:a', 'aac', '-b:a', '48k']
  }

  const tmp = `${file}.${process.pid}.tmp.mp4`
  await ffmpeg([
    ...inputs,
    ...audioInputs,
    '-filter_complex',
    videoGraph + audioGraph,
    '-map',
    '[v]',
    ...audioMap,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-force_key_frames',
    `expr:gte(t,n_forced*${keyframeEverySec})`,
    '-sc_threshold',
    '0',
    '-movflags',
    '+faststart',
    tmp,
  ])
  fs.renameSync(tmp, file)
  return file
}

/**
 * Real speech from the macOS voices (Lekha speaks Hindi, Aman and Samantha English), as 16 kHz mono WAV.
 * Returns null where `say` does not exist, so tests that need it can skip.
 */
export function makeSpeech(name: string, voice: string, text: string): string | null {
  if (process.platform !== 'darwin') return null
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const wav = path.join(CACHE_DIR, `speech-${name}.wav`)
  if (fs.existsSync(wav)) return wav
  const aiff = path.join(CACHE_DIR, `speech-${name}.aiff`)
  const said = spawnSync('say', ['-v', voice, '-o', aiff, text])
  if (said.status !== 0) return null
  const conv = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    aiff,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wav,
  ])
  fs.rmSync(aiff, { force: true })
  return conv.status === 0 ? wav : null
}

/** A video (flat colour) whose soundtrack is the given audio file. */
export async function makeVideoWithAudio(audioFile: string, name: string): Promise<string> {
  const file = path.join(CACHE_DIR, `speech-video-${name}.mp4`)
  if (fs.existsSync(file)) return file
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=navy:s=320x180:r=10',
    '-i',
    audioFile,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    file,
  ])
  return file
}
