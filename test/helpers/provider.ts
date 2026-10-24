import type {
  RawTranscript,
  RawWord,
  TranscribeOptions,
  TranscriptionProvider,
} from '../../src/transcription/types.js'

/**
 * Speech recognition for tests: no engine, no keys. It says what it is told to say, and can be told to
 * fail, to fail once, or to block until cancelled, so the pipeline's failure handling can be exercised.
 */
export class ScriptedProvider implements TranscriptionProvider {
  readonly name = 'scripted'
  readonly model = 'test-model'
  readonly diarizes = false
  calls = 0
  active = 0
  maxActive = 0
  languages: string[] = []

  constructor(
    public behaviour: (
      call: number,
      opts: TranscribeOptions,
    ) => Promise<RawTranscript> | RawTranscript,
  ) {}

  async transcribe(_audioPath: string, opts: TranscribeOptions): Promise<RawTranscript> {
    const call = ++this.calls
    this.languages.push(opts.language)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      return await this.behaviour(call, opts)
    } finally {
      this.active--
    }
  }
}

/** A line of Hinglish as Whisper writes it (Devanagari), over the first seconds of a video. */
export const HINGLISH: RawWord[] = [
  ['नमस्ते', 0.5, 0.9],
  ['दोस्तों,', 0.9, 1.4],
  ['आज', 1.5, 1.8],
  ['फंडिंग', 1.8, 2.3],
  ['कैसे', 2.4, 2.7],
  ['रेज़', 2.7, 3.1],
  ['करें?', 3.1, 3.6],
  ['अम', 5.0, 5.3],
  ['मतलब', 5.3, 5.8],
  ['मेरी', 6.0, 6.3],
  ['सबसे', 6.3, 6.6],
  ['बड़ी', 6.6, 6.9],
  ['गलती', 6.9, 7.3],
  ['थी', 7.3, 7.5],
  ['चालीस', 7.5, 7.9],
  ['लाख', 7.9, 8.2],
  ['रुपये', 8.2, 8.7],
  ['खर्च', 8.7, 9.0],
  ['कर', 9.0, 9.2],
  ['दिए।', 9.2, 9.8],
  ['और', 11.0, 11.2],
  ['आज', 11.2, 11.5],
  ['की', 11.5, 11.6],
  ['बात', 11.6, 11.9],
  ['खत्म।', 11.9, 12.5],
].map(([text, start, end]) => ({
  text: text as string,
  start: start as number,
  end: end as number,
}))

export const speaks = (words: RawWord[] = HINGLISH): RawTranscript => ({ language: 'hi', words })

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
