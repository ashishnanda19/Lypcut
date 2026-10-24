import { spawn } from 'node:child_process'
import { z } from 'zod'
import { AppError } from './errors.js'

/** What we need to know about a media file. */
export interface MediaInfo {
  durationSec: number
  width: number
  height: number
  videoCodec: string
  audioCodec: string | null
  hasAudio: boolean
  formatName: string
  bitRate: number | null
  /** Frames per second of the video stream, if it has one. */
  fps: number | null
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Container families we accept, judged by what ffprobe finds inside the file, not by its name or
 * the type the browser claimed. Images and other things ffmpeg can open (png, gif, playlists) are out.
 */
const ACCEPTED_FORMATS = ['mov', 'mp4', 'matroska', 'webm', 'avi']

const probeSchema = z.object({
  format: z.object({
    format_name: z.string(),
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
  }),
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      duration: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      disposition: z.object({ attached_pic: z.number().optional() }).optional(),
    }),
  ),
})

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let stderr = ''
    let size = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) child.kill('SIGKILL')
      else out += chunk
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else
        reject(
          new Error(
            signal ? `ffprobe was stopped (${signal})` : `ffprobe failed: ${stderr.trim()}`,
          ),
        )
    })
  })
}

const notMedia = () =>
  new AppError(
    415,
    'UNSUPPORTED_MEDIA',
    'That file is not a video we can read. Upload an MP4, MOV, MKV, WebM or AVI file.',
  )

/**
 * Reads a file's metadata. `input` is a local path or an http(s) URL (a presigned URL, so only the
 * header is fetched, not the whole video). Throws UNSUPPORTED_MEDIA if it is not a usable video.
 */
export async function probeMedia(
  input: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<MediaInfo> {
  let raw: string
  try {
    raw = await run(
      opts.bin ?? 'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-protocol_whitelist',
        'file,http,https,tcp,tls,crypto',
        input,
      ],
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (e) {
    // ffprobe exits non-zero for a file it cannot parse. A missing binary is a server fault, not the user's.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e
    throw notMedia()
  }

  let parsed: z.infer<typeof probeSchema>
  try {
    parsed = probeSchema.parse(JSON.parse(raw))
  } catch {
    throw notMedia()
  }

  const formats = parsed.format.format_name.split(',')
  if (!formats.some((f) => ACCEPTED_FORMATS.includes(f))) throw notMedia()

  // A video stream that is just cover art does not make a file a video.
  const video = parsed.streams.find(
    (s) =>
      s.codec_type === 'video' &&
      !s.disposition?.attached_pic &&
      (s.width ?? 0) > 0 &&
      (s.height ?? 0) > 0,
  )
  if (!video) throw notMedia()
  const audio = parsed.streams.find((s) => s.codec_type === 'audio')

  const durationSec = Number(parsed.format.duration ?? video.duration)
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw notMedia()

  const [num, den] = (video.avg_frame_rate ?? '0/1').split('/').map(Number)
  const fps = den ? num! / den : null

  return {
    durationSec,
    width: video.width!,
    height: video.height!,
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    formatName: parsed.format.format_name,
    bitRate: parsed.format.bit_rate ? Number(parsed.format.bit_rate) : null,
    fps: fps && Number.isFinite(fps) ? fps : null,
  }
}
