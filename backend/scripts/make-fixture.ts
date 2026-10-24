/**
 * Generates a small sample video with FFmpeg: 30 seconds, four scenes (picture cuts at 6, 14 and 22 s), a tone
 * with a pause in it, a keyframe every second. Nothing large is ever committed; run this when you want one.
 *
 *   npm run fixtures        ->  test/fixtures/sample.mp4
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeSceneVideo } from '../test/helpers/media.js'

const file = await makeSceneVideo({
  segments: [
    { color: 'red', seconds: 6 },
    { color: 'blue', seconds: 8 },
    { color: 'green', seconds: 8 },
    { color: 'purple', seconds: 8 },
  ],
  audio: [
    ['tone', 10],
    ['silence', 2],
    ['tone', 18],
  ],
})
const out = path.resolve(import.meta.dirname, '../test/fixtures/sample.mp4')
fs.copyFileSync(file, out)
console.log(`wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`)
