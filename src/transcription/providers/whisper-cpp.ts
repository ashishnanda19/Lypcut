import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { CancelledError, MediaError, runBinary } from '../../media/ffmpeg.js'
import {
  TranscriptionError,
  type RawTranscript,
  type RawWord,
  type TranscribeOptions,
  type TranscriptionProvider,
} from '../types.js'

export interface WhisperCppOptions {
  /** The whisper.cpp command-line binary (whisper-cli). */
  bin: string
  /** A ggml model file, for example ggml-small.bin. */
  modelPath: string
  threads: number
  /** Optional priming text. */
  prompt?: string
  /** Give up on one transcription after this long. */
  timeoutMs?: number
}

const output = z.object({
  result: z.object({ language: z.string().optional() }).partial().optional(),
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
    }),
  ),
})

/**
 * Local speech recognition with whisper.cpp: no account, no network, so it works on a laptop. Whisper has
 * no "Hinglish" model, so Hindi and Hinglish are both transcribed as Hindi, which writes Hindi words in
 * Devanagari and (usually) English words in Devanagari too. The normaliser restores the English spellings.
 *
 * `--max-len 1 --split-on-word` makes whisper.cpp emit one segment per word, each with its own timestamps.
 * It does not separate speakers, so everything is one speaker; use a hosted provider for diarization.
 */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = 'whisper-local'
  readonly model: string
  readonly diarizes = false

  constructor(private readonly opts: WhisperCppOptions) {
    this.model = path
      .basename(opts.modelPath)
      .replace(/^ggml-/, '')
      .replace(/\.bin$/, '')
  }

  async transcribe(audioPath: string, t: TranscribeOptions): Promise<RawTranscript> {
    // A missing binary or model is a set-up problem that no retry will fix.
    if (!fs.existsSync(this.opts.modelPath)) {
      throw new TranscriptionError(
        `The Whisper model is missing at ${this.opts.modelPath}. Run: npm run models:download`,
        false,
      )
    }

    const prefix = path.join(path.dirname(audioPath), `whisper-${process.pid}-${Date.now()}`)
    const jsonFile = `${prefix}.json`
    const args = [
      '-m',
      this.opts.modelPath,
      '-f',
      audioPath,
      '-l',
      t.language === 'en' ? 'en' : 'hi',
      '-t',
      String(this.opts.threads),
      '-ml',
      '1',
      '--split-on-word',
      '--output-json',
      '--output-file',
      prefix,
      '--print-progress',
      ...(this.opts.prompt ? ['--prompt', this.opts.prompt] : []),
    ]

    try {
      await runBinary(this.opts.bin, args, {
        signal: t.signal,
        timeoutMs: this.opts.timeoutMs ?? 6 * 3600_000,
        onStderrLine: (line) => {
          const m = /progress\s*=\s*(\d+)%/.exec(line)
          if (m && t.onProgress) t.onProgress(Number(m[1]) / 100)
        },
      })
      const parsed = output.parse(JSON.parse(fs.readFileSync(jsonFile, 'utf8')))
      return { language: parsed.result?.language, words: toWords(parsed.transcription) }
    } catch (e) {
      if (e instanceof CancelledError || e instanceof TranscriptionError) throw e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(jsonFile)) {
        throw new TranscriptionError(
          `Could not run ${this.opts.bin}. Install whisper.cpp or set WHISPER_BIN.`,
          false,
        )
      }
      // Killed by the system (out of memory) is worth another go; a bad file or crash is not.
      const killed = e instanceof MediaError && /was stopped \(SIG/.test(e.message)
      throw new TranscriptionError(`Whisper failed: ${(e as Error).message}`, killed)
    } finally {
      fs.rmSync(jsonFile, { force: true })
    }
  }
}

function toWords(segments: z.infer<typeof output>['transcription']): RawWord[] {
  const words: RawWord[] = []
  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue
    words.push({ text, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 })
  }
  return words
}
