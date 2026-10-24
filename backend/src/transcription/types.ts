import type { Lang } from '../modules/account/schema.js'

/** One word as a speech-recognition provider reports it, in SOURCE time (seconds into the upload). */
export interface RawWord {
  /** As spoken, in whichever script the provider chose. May carry punctuation ("hai.", "doston,"). */
  text: string
  start: number
  end: number
  confidence?: number
  /** The provider's own speaker label ("A", "speaker_0"...), if it separates speakers. */
  speaker?: string
}

export interface RawTranscript {
  /** The language the provider says it heard, if it says. */
  language?: string
  words: RawWord[]
}

export interface TranscribeOptions {
  /** What the user told us they speak. Hindi and Hinglish both use the Hindi model, since none is made for Hinglish. */
  language: Lang
  signal?: AbortSignal
  /** 0-1, if the provider can tell how far along it is. */
  onProgress?: (fraction: number) => void
}

/** Speech recognition behind one interface, so the engine can change without touching the pipeline. */
export interface TranscriptionProvider {
  readonly name: string
  /** The model, for the record. */
  readonly model: string | null
  /** Whether the provider can tell speakers apart. */
  readonly diarizes: boolean
  /** Turns a mono 16 kHz WAV file into timed words. */
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<RawTranscript>
}

/**
 * `retryable` separates "the service hiccupped, try again" (network, rate limit, a 5xx) from "this will
 * never work" (a bad key, an unreadable file), so the pipeline does not retry the second kind five times.
 */
export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}
