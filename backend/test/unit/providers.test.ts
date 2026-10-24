import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/lib/config.js'
import { CancelledError, run } from '../../src/media/ffmpeg.js'
import { AssemblyAiProvider } from '../../src/transcription/providers/assemblyai.js'
import { createTranscriptionProvider } from '../../src/transcription/providers/index.js'
import { OpenAiProvider, spreadSegments } from '../../src/transcription/providers/openai.js'
import { WhisperCppProvider } from '../../src/transcription/providers/whisper-cpp.js'
import { TranscriptionError } from '../../src/transcription/types.js'
import { json, startServer, type TestServer } from '../helpers/http-server.js'
import { TEST_ENV } from '../helpers/env.js'

let dir: string
let wav: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lypcut-prov-'))
  wav = path.join(dir, 'audio.wav')
  await run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000:duration=5',
    '-ac',
    '1',
    wav,
  ])
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const expectError = async (p: Promise<unknown>) => {
  const e = await p.catch((x) => x)
  expect(e).toBeInstanceOf(TranscriptionError)
  return e as TranscriptionError
}

/* --------------------------------------------------------------------- */
/* whisper.cpp, with a stand-in binary that behaves like whisper-cli       */
/* --------------------------------------------------------------------- */

describe('WhisperCppProvider', () => {
  let model: string
  let log: string
  beforeAll(() => {
    model = path.join(dir, 'ggml-small.bin')
    fs.writeFileSync(model, 'fake model')
    log = path.join(dir, 'args.log')
  })

  /** A shell script that records its arguments and writes whisper-cli-shaped JSON to --output-file. */
  const fakeBin = (mode: 'ok' | 'crash' | 'killed' | 'slow' = 'ok') => {
    const file = path.join(dir, `whisper-${mode}.sh`)
    const json = JSON.stringify({
      result: { language: 'hi' },
      transcription: [
        { offsets: { from: 0, to: 420 }, text: ' नमस्ते' },
        { offsets: { from: 420, to: 900 }, text: ' दोस्तों,' },
        { offsets: { from: 900, to: 900 }, text: '   ' },
        { offsets: { from: 1000, to: 1500 }, text: ' फंडिंग' },
      ],
    })
    fs.writeFileSync(
      file,
      `#!/bin/sh
echo "$@" > "${log}"
while [ $# -gt 0 ]; do [ "$1" = "--output-file" ] && out="$2"; shift; done
case "${mode}" in
  crash) echo "whisper: bad audio" >&2; exit 1;;
  killed) kill -9 $$;;
  slow) sleep 30;;
esac
echo "whisper_print_progress_callback: progress =  25%" >&2
echo "whisper_print_progress_callback: progress = 100%" >&2
cat > "$out.json" <<'EOF'
${json}
EOF
`,
      { mode: 0o755 },
    )
    return file
  }
  const provider = (bin: string, extra: object = {}) =>
    new WhisperCppProvider({ bin, modelPath: model, threads: 3, ...extra })

  it('turns whisper-cli output into timed words, in seconds', async () => {
    const out = await provider(fakeBin()).transcribe(wav, { language: 'hinglish' })
    expect(out.language).toBe('hi')
    expect(out.words).toEqual([
      { text: 'नमस्ते', start: 0, end: 0.42 },
      { text: 'दोस्तों,', start: 0.42, end: 0.9 },
      { text: 'फंडिंग', start: 1, end: 1.5 },
    ])
  })

  it('uses the Hindi model for Hindi and Hinglish, English for English', async () => {
    const p = provider(fakeBin(), { prompt: 'Namaste dosto' })
    await p.transcribe(wav, { language: 'hinglish' })
    const hinglish = fs.readFileSync(log, 'utf8')
    expect(hinglish).toMatch(/-l hi /)
    expect(hinglish).toMatch(/-t 3 /)
    expect(hinglish).toMatch(/-ml 1 --split-on-word/)
    expect(hinglish).toContain(`-m ${model}`)
    expect(hinglish).toContain('--prompt Namaste dosto')
    await p.transcribe(wav, { language: 'en' })
    expect(fs.readFileSync(log, 'utf8')).toMatch(/-l en /)
    await p.transcribe(wav, { language: 'hi' })
    expect(fs.readFileSync(log, 'utf8')).toMatch(/-l hi /)
  })

  it('reports progress as it goes', async () => {
    const seen: number[] = []
    await provider(fakeBin()).transcribe(wav, { language: 'en', onProgress: (f) => seen.push(f) })
    expect(seen).toEqual([0.25, 1])
  })

  it('names itself and its model', () => {
    const p = provider('whisper-cli')
    expect(p.name).toBe('whisper-local')
    expect(p.model).toBe('small')
    expect(p.diarizes).toBe(false)
  })

  it('says how to fix a missing model, and does not suggest retrying', async () => {
    const p = new WhisperCppProvider({
      bin: fakeBin(),
      modelPath: '/no/ggml-small.bin',
      threads: 1,
    })
    const e = await expectError(p.transcribe(wav, { language: 'en' }))
    expect(e.retryable).toBe(false)
    expect(e.message).toMatch(/npm run models:download/)
  })

  it('says how to fix a missing binary, and does not suggest retrying', async () => {
    const e = await expectError(
      provider('/no/such/whisper-cli').transcribe(wav, { language: 'en' }),
    )
    expect(e.retryable).toBe(false)
    expect(e.message).toMatch(/WHISPER_BIN/)
  })

  it('a crash is not retried, but being killed (out of memory) is', async () => {
    const crash = await expectError(provider(fakeBin('crash')).transcribe(wav, { language: 'en' }))
    expect(crash.retryable).toBe(false)
    expect(crash.message).toMatch(/bad audio/)
    const killed = await expectError(
      provider(fakeBin('killed')).transcribe(wav, { language: 'en' }),
    )
    expect(killed.retryable).toBe(true)
  })

  it('can be cancelled, and stops the process', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const job = provider(fakeBin('slow')).transcribe(wav, {
      language: 'en',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    await expect(job).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('leaves no result file behind', async () => {
    await provider(fakeBin()).transcribe(wav, { language: 'en' })
    expect(
      fs.readdirSync(dir).filter((f) => f.startsWith('whisper-') && f.endsWith('.json')),
    ).toEqual([])
  })
})

/* --------------------------------------------------------------------- */
/* OpenAI                                                                  */
/* --------------------------------------------------------------------- */

describe('OpenAiProvider', () => {
  let server: TestServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const make = (url: string, extra: object = {}) =>
    new OpenAiProvider({ apiKey: 'sk-test', baseUrl: url, model: 'whisper-1', ...extra })
  const reply = (words: Array<[string, number, number]>) => ({
    language: 'hindi',
    words: words.map(([word, start, end]) => ({ word, start, end })),
  })

  it('sends a verbose_json request with word timestamps, the key and the right language', async () => {
    server = await startServer((_, res) => json(res, reply([['नमस्ते', 0, 0.5]])))
    const out = await make(server.url).transcribe(wav, { language: 'hinglish' })
    expect(out.words).toEqual([{ text: 'नमस्ते', start: 0, end: 0.5 }])

    const req = server.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/audio/transcriptions')
    expect(req.headers.authorization).toBe('Bearer sk-test')
    const body = req.body.toString('latin1')
    expect(body).toMatch(/name="model"\r\n\r\nwhisper-1/)
    expect(body).toMatch(/name="response_format"\r\n\r\nverbose_json/)
    expect(body).toMatch(/name="timestamp_granularities\[\]"\r\n\r\nword/)
    expect(body).toMatch(/name="language"\r\n\r\nhi/)
    expect(body).toMatch(/name="file"; filename="[^"]+\.mp3"/)
  })

  it('uses English for English', async () => {
    server = await startServer((_, res) => json(res, reply([['hello', 0, 0.5]])))
    await make(server.url).transcribe(wav, { language: 'en' })
    expect(server.requests[0]!.body.toString('latin1')).toMatch(/name="language"\r\n\r\nen/)
  })

  it('cuts long audio into pieces and puts every word back on the whole recording’s clock', async () => {
    server = await startServer((_, res) => json(res, reply([['piece', 0.5, 1]])))
    const seen: number[] = []
    // 5 seconds of audio in 2 second pieces: three requests.
    const out = await make(server.url, { chunkSec: 2 }).transcribe(wav, {
      language: 'en',
      onProgress: (f) => seen.push(f),
    })
    expect(server.requests).toHaveLength(3)
    expect(out.words.map((w) => w.start)).toEqual([0.5, 2.5, 4.5])
    expect(out.words.map((w) => w.end)).toEqual([1, 3, 5])
    expect(seen).toEqual([1 / 3, 2 / 3, 1])
  })

  it('falls back to segments when a response has no word times', async () => {
    server = await startServer((_, res) =>
      json(res, {
        language: 'en',
        segments: [{ text: ' one two three four', start: 10, end: 14 }],
      }),
    )
    const out = await make(server.url).transcribe(wav, { language: 'en' })
    expect(out.words.map((w) => [w.text, w.start])).toEqual([
      ['one', 10],
      ['two', 11],
      ['three', 12],
      ['four', 13],
    ])
  })

  it('spreadSegments gives each word an equal share and copes with an empty segment', () => {
    expect(spreadSegments([{ text: '', start: 0, end: 1 }])).toEqual([])
    const [a, b] = spreadSegments([{ text: 'a b', start: 2, end: 4 }])
    expect([a!.end, b!.start]).toEqual([3, 3])
  })

  it('does not retry a rejected key, but does retry rate limits and server errors', async () => {
    for (const [status, retryable] of [
      [401, false],
      [403, false],
      [400, false],
      [413, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      server = await startServer((_, res) => json(res, { error: { message: 'no' } }, status))
      const e = await expectError(make(server.url).transcribe(wav, { language: 'en' }))
      expect(e.retryable, `HTTP ${status}`).toBe(retryable)
      if (status === 401) expect(e.message).toMatch(/API key/)
      await server.close()
      server = undefined
    }
  })

  it('treats an unreadable response as retryable and an unreachable server as retryable', async () => {
    server = await startServer((_, res) => json(res, { nonsense: true }))
    const bad = await expectError(make(server.url).transcribe(wav, { language: 'en' }))
    expect(bad.retryable).toBe(true)
    const url = server.url
    await server.close()
    server = undefined
    const down = await expectError(make(url).transcribe(wav, { language: 'en' }))
    expect(down.retryable).toBe(true)
    expect(down.message).toMatch(/Could not reach OpenAI/)
  })

  it('removes its temporary audio pieces', async () => {
    server = await startServer((_, res) => json(res, reply([['x', 0, 1]])))
    await make(server.url, { chunkSec: 2 }).transcribe(wav, { language: 'en' })
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('openai-'))).toEqual([])
  })
})

/* --------------------------------------------------------------------- */
/* AssemblyAI                                                              */
/* --------------------------------------------------------------------- */

describe('AssemblyAiProvider', () => {
  let server: TestServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  /** Replies like AssemblyAI: upload, create, then `processing` a few times before `completed`. */
  const api = (opts: { processingPolls?: number; final?: object } = {}) => {
    let polls = 0
    return startServer((req, res) => {
      if (req.url === '/v2/upload') return json(res, { upload_url: 'https://cdn.example/audio' })
      if (req.url === '/v2/transcript' && req.method === 'POST')
        return json(res, { id: 'tr_1', status: 'queued' })
      if (req.url === '/v2/transcript/tr_1') {
        polls++
        if (polls <= (opts.processingPolls ?? 2))
          return json(res, { id: 'tr_1', status: 'processing' })
        return json(
          res,
          opts.final ?? {
            id: 'tr_1',
            status: 'completed',
            language_code: 'hi',
            words: [
              { text: 'नमस्ते', start: 0, end: 420, confidence: 0.98, speaker: 'A' },
              { text: 'थैंक', start: 1500, end: 1900, confidence: 0.9, speaker: 'B' },
            ],
          },
        )
      }
      json(res, {}, 404)
    })
  }
  const make = (url: string, extra: object = {}) =>
    new AssemblyAiProvider({ apiKey: 'aai-key', baseUrl: url, pollMs: 10, ...extra })

  it('uploads, requests speaker labels, waits, and returns timed, labelled words in seconds', async () => {
    server = await api()
    const out = await make(server.url).transcribe(wav, { language: 'hinglish' })
    expect(out.language).toBe('hi')
    expect(out.words).toEqual([
      { text: 'नमस्ते', start: 0, end: 0.42, confidence: 0.98, speaker: 'A' },
      { text: 'थैंक', start: 1.5, end: 1.9, confidence: 0.9, speaker: 'B' },
    ])

    const [upload, create, ...polls] = server.requests
    expect(upload!.url).toBe('/v2/upload')
    expect(upload!.body.length).toBe(fs.statSync(wav).size)
    expect(upload!.headers.authorization).toBe('aai-key')
    expect(JSON.parse(create!.body.toString())).toEqual({
      audio_url: 'https://cdn.example/audio',
      language_code: 'hi',
      speaker_labels: true,
      punctuate: true,
      format_text: true,
    })
    expect(polls).toHaveLength(3)
    expect(new AssemblyAiProvider({ apiKey: 'k', baseUrl: 'x' }).diarizes).toBe(true)
  })

  it('asks for English when the speaker is English', async () => {
    server = await api({ processingPolls: 0 })
    await make(server.url).transcribe(wav, { language: 'en' })
    expect(JSON.parse(server.requests[1]!.body.toString()).language_code).toBe('en')
  })

  it('a transcript the service refuses is not retried', async () => {
    server = await api({
      processingPolls: 0,
      final: { id: 'tr_1', status: 'error', error: 'no speech detected' },
    })
    const e = await expectError(make(server.url).transcribe(wav, { language: 'en' }))
    expect(e.retryable).toBe(false)
    expect(e.message).toMatch(/no speech detected/)
  })

  it('gives up waiting after the timeout, and that is retryable', async () => {
    server = await api({ processingPolls: 1_000_000 })
    const e = await expectError(
      make(server.url, { timeoutMs: 100 }).transcribe(wav, { language: 'en' }),
    )
    expect(e.retryable).toBe(true)
    expect(e.message).toMatch(/took too long/)
  })

  it('can be cancelled while it waits', async () => {
    server = await api({ processingPolls: 1_000_000 })
    const controller = new AbortController()
    const job = make(server.url, { pollMs: 50 }).transcribe(wav, {
      language: 'en',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    await expect(job).rejects.toBeInstanceOf(CancelledError)
  })

  it('does not retry a bad key', async () => {
    server = await startServer((_, res) => json(res, { error: 'Unauthorized' }, 401))
    const e = await expectError(make(server.url).transcribe(wav, { language: 'en' }))
    expect(e.retryable).toBe(false)
    expect(e.message).toMatch(/API key/)
  })
})

/* --------------------------------------------------------------------- */
/* Choosing and configuring a provider                                      */
/* --------------------------------------------------------------------- */

describe('createTranscriptionProvider', () => {
  const cfg = (extra: Record<string, string>) => loadConfig({ ...TEST_ENV, ...extra })

  it('defaults to local Whisper, which needs no account', () => {
    const p = createTranscriptionProvider(cfg({}))
    expect(p.name).toBe('whisper-local')
  })

  it('picks the hosted providers by name', () => {
    expect(
      createTranscriptionProvider(cfg({ TRANSCRIPTION_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }))
        .name,
    ).toBe('openai')
    expect(
      createTranscriptionProvider(
        cfg({ TRANSCRIPTION_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'k' }),
      ).name,
    ).toBe('assemblyai')
  })

  it('refuses to start without the key for the chosen provider', () => {
    expect(() => cfg({ TRANSCRIPTION_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/)
    expect(() => cfg({ TRANSCRIPTION_PROVIDER: 'assemblyai' })).toThrow(/ASSEMBLYAI_API_KEY/)
    expect(() => cfg({ TRANSCRIPTION_PROVIDER: 'whisper-local' })).not.toThrow()
  })

  it('rejects an unknown provider name', () => {
    expect(() => cfg({ TRANSCRIPTION_PROVIDER: 'magic' })).toThrow(/TRANSCRIPTION_PROVIDER/)
  })
})
