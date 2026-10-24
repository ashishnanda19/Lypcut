import fs from 'node:fs'
import { z } from 'zod'
import { CancelledError } from '../../media/ffmpeg.js'
import {
  TranscriptionError,
  type RawTranscript,
  type TranscribeOptions,
  type TranscriptionProvider,
} from '../types.js'
import { errorForStatus, networkError, sleep, type FetchLike } from './hosted.js'

export interface AssemblyAiOptions {
  apiKey: string
  baseUrl: string
  fetch?: FetchLike
  /** How often to ask whether the transcript is ready. */
  pollMs?: number
  /** Stop waiting after this long. */
  timeoutMs?: number
}

const upload = z.object({ upload_url: z.string() })
const transcript = z.object({
  id: z.string(),
  status: z.enum(['queued', 'processing', 'completed', 'error']),
  error: z.string().nullish(),
  language_code: z.string().nullish(),
  words: z
    .array(
      z.object({
        text: z.string(),
        start: z.number(),
        end: z.number(),
        confidence: z.number().nullish(),
        speaker: z.string().nullish(),
      }),
    )
    .nullish(),
})

/**
 * AssemblyAI: upload the audio, ask for a transcript with speaker labels, wait for it. This is the
 * provider that separates speakers. Times come back in milliseconds.
 */
export class AssemblyAiProvider implements TranscriptionProvider {
  readonly name = 'assemblyai'
  readonly model = 'best'
  readonly diarizes = true
  private readonly http: FetchLike
  private readonly base: string

  constructor(private readonly opts: AssemblyAiOptions) {
    this.http = opts.fetch ?? fetch
    this.base = opts.baseUrl.replace(/\/$/, '')
  }

  async transcribe(audioPath: string, t: TranscribeOptions): Promise<RawTranscript> {
    const audioUrl = await this.upload(audioPath, t)
    const id = await this.create(audioUrl, t)
    const done = await this.waitFor(id, t)
    return {
      language: done.language_code ?? undefined,
      words: (done.words ?? []).map((w) => ({
        text: w.text,
        start: w.start / 1000,
        end: w.end / 1000,
        ...(w.confidence != null ? { confidence: w.confidence } : {}),
        ...(w.speaker ? { speaker: w.speaker } : {}),
      })),
    }
  }

  private async call(path: string, init: RequestInit & { duplex?: 'half' }, t: TranscribeOptions) {
    let res: Response
    try {
      res = await this.http(`${this.base}${path}`, {
        ...init,
        headers: { authorization: this.opts.apiKey, ...(init.headers as Record<string, string>) },
        signal: t.signal,
      })
    } catch (e) {
      if (t.signal?.aborted) throw new CancelledError()
      throw networkError('AssemblyAI', e)
    }
    if (!res.ok) throw errorForStatus('AssemblyAI', res.status, await res.text())
    return res
  }

  private async upload(audioPath: string, t: TranscribeOptions): Promise<string> {
    // Streamed from disk: nothing is read into memory.
    const res = await this.call(
      '/v2/upload',
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: fs.createReadStream(audioPath) as unknown as RequestInit['body'],
        duplex: 'half',
      },
      t,
    )
    return upload.parse(await res.json()).upload_url
  }

  private async create(audioUrl: string, t: TranscribeOptions): Promise<string> {
    const res = await this.call(
      '/v2/transcript',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audio_url: audioUrl,
          // Hindi and Hinglish both use the Hindi setting; there is no Hinglish language code.
          language_code: t.language === 'en' ? 'en' : 'hi',
          speaker_labels: true,
          punctuate: true,
          format_text: true,
        }),
      },
      t,
    )
    return transcript.parse(await res.json()).id
  }

  private async waitFor(id: string, t: TranscribeOptions) {
    const deadline = Date.now() + (this.opts.timeoutMs ?? 3 * 3600_000)
    const poll = this.opts.pollMs ?? 3000
    for (;;) {
      const res = await this.call(`/v2/transcript/${id}`, { method: 'GET' }, t)
      const body = transcript.parse(await res.json())
      if (body.status === 'completed') return body
      if (body.status === 'error') {
        // The service looked at the audio and refused it: trying again will not change that.
        throw new TranscriptionError(
          `AssemblyAI could not transcribe this audio: ${body.error ?? 'unknown error'}`,
          false,
        )
      }
      if (Date.now() > deadline) throw new TranscriptionError('AssemblyAI took too long.', true)
      await sleep(poll, t.signal).catch(() => {
        throw new CancelledError()
      })
    }
  }
}
