import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { run, CancelledError } from '../../media/ffmpeg.js'
import {
  TranscriptionError,
  type RawTranscript,
  type RawWord,
  type TranscribeOptions,
  type TranscriptionProvider,
} from '../types.js'
import { errorForStatus, fileBlob, networkError, type FetchLike } from './hosted.js'

export interface OpenAiOptions {
  apiKey: string
  baseUrl: string
  model: string
  /** Injected in tests. */
  fetch?: FetchLike
  /** Audio is sent in pieces this long, since the API caps a file at 25 MB. */
  chunkSec?: number
}

const response = z.object({
  language: z.string().optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
  segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
})

/**
 * OpenAI's Whisper API. The audio is re-encoded to a small MP3 and cut into pieces under the API's size
 * cap; each piece is sent in turn and its times are shifted back onto the whole recording. Word-level
 * timestamps are requested; if a response lacks them, segment text is spread evenly across the segment.
 * Does not separate speakers.
 */
export class OpenAiProvider implements TranscriptionProvider {
  readonly name = 'openai'
  readonly diarizes = false
  private readonly http: FetchLike
  private readonly chunkSec: number

  constructor(private readonly opts: OpenAiOptions) {
    this.http = opts.fetch ?? fetch
    this.chunkSec = opts.chunkSec ?? 20 * 60
  }

  get model() {
    return this.opts.model
  }

  async transcribe(audioPath: string, t: TranscribeOptions): Promise<RawTranscript> {
    const dir = path.dirname(audioPath)
    const stem = path.join(dir, `openai-${process.pid}-${Date.now()}`)
    const pattern = `${stem}-%04d.mp3`
    try {
      await run(
        [
          '-i',
          audioPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '32k',
          '-f',
          'segment',
          '-segment_time',
          String(this.chunkSec),
          '-reset_timestamps',
          '1',
          pattern,
        ],
        { signal: t.signal },
      )
      const chunks = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(path.basename(stem)) && f.endsWith('.mp3'))
        .sort()
        .map((f) => path.join(dir, f))

      const words: RawWord[] = []
      let language: string | undefined
      for (const [i, chunk] of chunks.entries()) {
        const part = await this.sendChunk(chunk, t)
        const offset = i * this.chunkSec
        language ??= part.language
        for (const w of part.words)
          words.push({ ...w, start: w.start + offset, end: w.end + offset })
        t.onProgress?.((i + 1) / chunks.length)
      }
      return { language, words }
    } catch (e) {
      if (e instanceof CancelledError || e instanceof TranscriptionError) throw e
      throw new TranscriptionError(
        `Could not prepare audio for OpenAI: ${(e as Error).message}`,
        false,
      )
    } finally {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(path.basename(stem))) fs.rmSync(path.join(dir, f), { force: true })
      }
    }
  }

  private async sendChunk(file: string, t: TranscribeOptions) {
    const form = new FormData()
    form.append('file', await fileBlob(file, 'audio/mpeg'), path.basename(file))
    form.append('model', this.opts.model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
    // Hindi and Hinglish both use the Hindi setting; there is no Hinglish language code.
    form.append('language', t.language === 'en' ? 'en' : 'hi')

    let res: Response
    try {
      res = await this.http(`${this.opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: t.signal,
      })
    } catch (e) {
      if (t.signal?.aborted) throw new CancelledError()
      throw networkError('OpenAI', e)
    }
    if (!res.ok) throw errorForStatus('OpenAI', res.status, await res.text())

    const parsed = response.safeParse(await res.json())
    // A genuine "no speech" reply carries empty lists. A reply with neither list is not a transcript at all,
    // and treating it as an empty one would quietly lose what the person said.
    if (!parsed.success || (parsed.data.words === undefined && parsed.data.segments === undefined))
      throw new TranscriptionError('OpenAI sent a response we could not read.', true)

    if (parsed.data.words?.length) {
      return {
        language: parsed.data.language,
        words: parsed.data.words.map((w) => ({ text: w.word, start: w.start, end: w.end })),
      }
    }
    return { language: parsed.data.language, words: spreadSegments(parsed.data.segments ?? []) }
  }
}

/** No word timestamps? Give each word of a segment an equal share of the segment's time. */
export function spreadSegments(
  segments: Array<{ text: string; start: number; end: number }>,
): RawWord[] {
  const out: RawWord[] = []
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean)
    const step = (seg.end - seg.start) / Math.max(tokens.length, 1)
    tokens.forEach((text, i) => {
      out.push({ text, start: seg.start + i * step, end: seg.start + (i + 1) * step })
    })
  }
  return out
}
