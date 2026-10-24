import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { loadConfigOrExit } from '../lib/bootstrap.js'

/**
 * Downloads the Whisper model that WHISPER_MODEL_PATH points at (for example ggml-small.bin) from the
 * whisper.cpp model repository, unless it is already there. Used by `npm run models:download` and by the
 * `whisper-model` service in docker-compose. Set WHISPER_MODEL_URL to fetch from a mirror instead.
 *
 * Bigger models hear Hindi better and run slower: tiny/base are for a quick look, small is the sensible
 * default for a laptop, medium and large-v3 are for real use on strong hardware or a hosted provider.
 */
const config = loadConfigOrExit()
const target = path.resolve(config.WHISPER_MODEL_PATH)
const name = path.basename(target)
const url =
  process.env.WHISPER_MODEL_URL ??
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`

// Even the smallest model is tens of megabytes; anything less is a failed or partial download.
const MIN_BYTES = 30 * 1024 * 1024

if (fs.existsSync(target) && fs.statSync(target).size >= MIN_BYTES) {
  console.log(`model already present: ${target}`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(target), { recursive: true })
console.log(`downloading ${name}\n  from ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`download failed: HTTP ${res.status}. Check the model name in WHISPER_MODEL_PATH.`)
  process.exit(1)
}

const total = Number(res.headers.get('content-length') ?? 0)
let received = 0
let lastPrinted = 0
const tmp = `${target}.download`
const source = Readable.fromWeb(res.body as ReadableStream)
source.on('data', (chunk: Buffer) => {
  received += chunk.length
  if (total && received - lastPrinted > 25 * 1024 * 1024) {
    lastPrinted = received
    console.log(
      `  ${Math.round((received / total) * 100)}%  (${Math.round(received / 1024 / 1024)} MB)`,
    )
  }
})
await pipeline(source, fs.createWriteStream(tmp))

if (fs.statSync(tmp).size < MIN_BYTES) {
  fs.rmSync(tmp, { force: true })
  console.error('download was incomplete')
  process.exit(1)
}
fs.renameSync(tmp, target)
console.log(`saved ${target} (${Math.round(fs.statSync(target).size / 1024 / 1024)} MB)`)
