/**
 * Differential test: the front end's timeline engine against this backend's port, on identical random edits.
 * They are two copies of one engine, and the server must agree with the browser about what an edit does.
 *
 *   npm run parity            compares 10 random runs of 150 edits each
 *   FRONTEND_DIR=... npm run parity   if the front end is not at ../frontend
 *
 * It lives outside the test suite because it reads the sibling front-end repository. Both engines start every step
 * from one shared state, apply the same op, and must either both refuse it (with the same message) or both produce
 * the same timeline (new clip ids aside, since the two engines name new clips differently).
 *
 * KNOWN DIVERGENCE (the front end's bug, fixed on the server): trimming the start of a clip shorter than 0.1 s makes
 * the front end's `clamp` bounds cross and leaves the clip at a negative time. Those cases are reported as "known"
 * and do not fail the run, until the front end is fixed (then run with STRICT=1).
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname)
const FE = path.resolve(process.env.FRONTEND_DIR ?? path.join(here, '../../../frontend'))
const STRICT = process.env.STRICT === '1'
const load = (rel: string) => import(pathToFileURL(path.join(FE, rel)).href)

const fe = await load('src/lib/timeline/ops.ts')
const feBuild = await load('src/lib/timeline/build.ts')
const seed_ = await load('src/mocks/data/seed.ts')
const be = await import('../../src/timeline-core/ops.js')

function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Tl = any // eslint-disable-line @typescript-eslint/no-explicit-any -- this script compares two engines through their JSON shape
// Both engines are given the same id generator, so new clips must match exactly, ids included.
const canon = (tl: Tl) => {
  const items = Object.values(tl.items).map((i: any) => ({ ...i }))
  items.sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify({
    items,
    settings: tl.settings,
    tracks: tl.tracks,
    sourceDuration: tl.sourceDuration,
  })
}
const invalidItem = (x: any) => x.start < -1e-3 || x.srcIn < -1e-3 || x.duration <= 0

const src = seed_.generateSource('p_funding', 0, 56)
let start: Tl = feBuild.buildInitialTimeline(src.scenes, src.duration)
const captions = Array.from({ length: 40 }, (_, i) => ({
  id: `c${i}`,
  trackId: 'trk_captions',
  kind: 'caption',
  label: `c${i}`,
  start: i * 3 + 1,
  duration: 2,
  srcIn: i * 3 + 1,
  meta: { text: `w${i}`, dev: `w${i}` },
}))
start = fe.applyOp(start, { type: 'addCaptions', items: captions }).timeline

const tally = { compared: 0, identical: 0, bothRefused: 0, known: 0, mismatches: 0 }
for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
  const rand = prng(seed)
  let cur: Tl = JSON.parse(JSON.stringify(start))
  for (let i = 0; i < 150; i++) {
    const items = Object.values(cur.items) as any[]
    if (!items.some((x) => x.kind === 'video')) break
    const pick = () => items[Math.floor(rand() * items.length)]
    const vids = items.filter((x) => x.kind === 'video')
    const clip = vids[Math.floor(rand() * vids.length)]
    const dur = Math.max(1, ...vids.map((x) => x.start + x.duration))
    const r = Math.floor(rand() * 12)
    const op: any =
      r === 0
        ? { type: 'split', itemId: clip.id, at: clip.start + clip.duration * (0.1 + rand() * 0.8) }
        : r === 1
          ? {
              type: 'trim',
              itemId: clip.id,
              edge: rand() < 0.5 ? 'start' : 'end',
              to: clip.start + clip.duration * rand(),
            }
          : r === 2
            ? { type: 'move', itemId: pick().id, start: rand() * dur }
            : r === 3
              ? { type: 'delete', itemIds: [pick().id] }
              : r === 4
                ? (() => {
                    const f = rand() * dur * 0.8
                    return { type: 'rippleDelete', from: f, to: f + 0.3 + rand() * 9 }
                  })()
                : r === 5
                  ? (() => {
                      const a = rand() * src.duration * 0.9
                      return { type: 'cutSource', srcFrom: a, srcTo: a + 0.3 + rand() * 14 }
                    })()
                  : r === 6
                    ? (() => {
                        const a = rand() * src.duration * 0.9
                        return { type: 'restoreSource', srcFrom: a, srcTo: a + 0.3 + rand() * 14 }
                      })()
                    : r === 7
                      ? {
                          type: 'addMarker',
                          marker: { id: `mk${i}_${seed}`, time: rand() * dur, label: 'm' },
                        }
                      : r === 8
                        ? {
                            type: 'setCrop',
                            crop: { x: rand() * 1.2 - 0.1, y: rand(), scale: 0.8 + rand() * 3.6 },
                          }
                        : r === 9
                          ? { type: 'setCaptionStyle', styleId: 'boxed' }
                          : r === 10
                            ? { type: 'rippleDelete', from: rand() * dur * 0.5, to: rand() * dur }
                            : {
                                type: 'batch',
                                ops: [
                                  {
                                    type: 'cutSource',
                                    srcFrom: rand() * 100,
                                    srcTo: 100 + rand() * 30,
                                  },
                                  {
                                    type: 'addMarker',
                                    marker: { id: `b${i}_${seed}`, time: 1, label: 'b' },
                                  },
                                ],
                              }

    let a: any,
      aErr: string | null = null,
      b: any,
      bErr: string | null = null
    try {
      a = fe.applyOp(cur, op, { newId: fe.sequentialIds(`p${seed}_${i}_`) })
    } catch (e) {
      if (e instanceof fe.OpError) aErr = (e as Error).message
      else throw e
    }
    try {
      b = be.applyOp(cur, op, { newId: be.sequentialIds(`p${seed}_${i}_`) })
    } catch (e) {
      if (e instanceof be.OpError) bErr = (e as Error).message
      else throw e
    }
    tally.compared++

    if (aErr || bErr) {
      if (aErr && bErr && aErr === bErr) {
        tally.bothRefused++
        continue
      }
      // The front end accepted something that leaves a clip invalid; the server refused: the known divergence.
      if (!aErr && bErr && Object.values(a.timeline.items).some(invalidItem)) {
        tally.known++
        if (STRICT) tally.mismatches++
        continue
      }
      tally.mismatches++
      console.log(
        'MISMATCH (one refused)',
        JSON.stringify(op).slice(0, 180),
        '\n  front end:',
        aErr ?? 'ok',
        '\n  backend  :',
        bErr ?? 'ok',
      )
      continue
    }
    if (Object.values(a.timeline.items).some(invalidItem)) {
      tally.known++
      if (STRICT) tally.mismatches++
      cur = JSON.parse(JSON.stringify(b.timeline))
      continue
    }
    if (canon(a.timeline) !== canon(b.timeline)) {
      tally.mismatches++
      console.log('MISMATCH (different result)', JSON.stringify(op).slice(0, 200))
      continue
    }
    tally.identical++
    cur = JSON.parse(JSON.stringify(b.timeline))
  }
}
console.log(JSON.stringify(tally))
process.exit(tally.mismatches ? 1 : 0)
