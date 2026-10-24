import { spawn } from 'node:child_process'

/**
 * Runs FFmpeg and FFprobe as child processes. Nothing is buffered beyond a small tail of stderr, so
 * memory use is flat whatever the video size. A run can be cancelled with an AbortSignal (the child
 * is killed), and is killed on its own if it exceeds a timeout.
 */

export interface RunOptions {
  signal?: AbortSignal
  /** Called for each line the process writes to stderr (used to read progress from other tools). */
  onStderrLine?: (line: string) => void
  timeoutMs?: number
  /** Called with seconds of output produced so far (from FFmpeg's -progress feed). */
  onProgress?: (outSeconds: number) => void
  /** Which tool to run. Defaults to ffmpeg. */
  tool?: 'ffmpeg' | 'ffprobe'
  /** Collect stdout (for parsers). Off by default so a large output cannot fill memory. */
  collectStdout?: boolean
  /** Cap on collected output, in bytes. */
  maxStdoutBytes?: number
}

/** Binary paths, set once at startup from FFMPEG_BIN and FFPROBE_BIN. */
const binaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
export function configureMedia(paths: Partial<typeof binaries>): void {
  Object.assign(binaries, paths)
}

export interface RunResult {
  stdout: string
  /** The last few KB of stderr, for error messages and parsers (e.g. silencedetect). */
  stderr: string
}

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly stderr = '',
  ) {
    super(message)
    this.name = 'MediaError'
  }
}

export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

const STDERR_TAIL = 64 * 1024

export function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const tool = opts.tool ?? 'ffmpeg'
  const progress = opts.onProgress !== undefined
  const full = [
    ...(tool === 'ffmpeg'
      ? ['-hide_banner', '-nostdin', '-y', ...(progress ? ['-progress', 'pipe:1', '-nostats'] : [])]
      : []),
    ...args,
  ]
  return runBinary(binaries[tool], full, opts)
}

/**
 * Runs any command-line tool with the same guarantees: bounded memory, cancellable, time limited.
 * FFmpeg's own progress feed is parsed when `onProgress` is set; `onStderrLine` serves other tools.
 */
export function runBinary(bin: string, full: string[], opts: RunOptions = {}): Promise<RunResult> {
  const progress = opts.onProgress !== undefined

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError())
    const child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stdoutBytes = 0
    let stderr = ''
    let carry = ''
    let errCarry = ''
    let settled = false
    const maxStdout = opts.maxStdoutBytes ?? 8 * 1024 * 1024

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new CancelledError()))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          finish(() =>
            reject(new MediaError(`${bin} timed out after ${opts.timeoutMs} ms`, stderr)),
          )
        }, opts.timeoutMs)
      : undefined

    child.stdout.on('data', (chunk: Buffer) => {
      if (progress) {
        // -progress emits "out_time_us=123456" style lines.
        carry += chunk.toString()
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (m) opts.onProgress!(Number(m[1]) / 1_000_000)
        }
      } else if (opts.collectStdout) {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxStdout) {
          child.kill('SIGKILL')
          finish(() => reject(new MediaError(`${bin} produced too much output`)))
        } else stdout += chunk
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
      if (stderr.length > STDERR_TAIL * 2) stderr = stderr.slice(-STDERR_TAIL)
      if (opts.onStderrLine) {
        errCarry += chunk.toString()
        const lines = errCarry.split(/[\r\n]+/)
        errCarry = lines.pop() ?? ''
        for (const line of lines) if (line) opts.onStderrLine(line)
      }
    })
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code, signal) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr: stderr.slice(-STDERR_TAIL) })
        else {
          const why = signal ? `was stopped (${signal})` : `exited with code ${code}`
          reject(new MediaError(`${bin} ${why}: ${lastLines(stderr, 6)}`, stderr))
        }
      })
    })
  })
}

export const lastLines = (text: string, n: number) => text.trim().split('\n').slice(-n).join(' | ')
