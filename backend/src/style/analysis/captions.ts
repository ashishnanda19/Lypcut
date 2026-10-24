import { distance, fromHex, hex, hsv, hueGap, luma, type Rgb } from './palette.js'

/**
 * Telling which of the editor's caption looks a Reel uses, from a handful of its frames, with no model and no text
 * recognition. The editor's looks differ in colour and shape (a coloured pill behind the spoken word, a dark box, a
 * yellow word with a black outline, a teal glow, a thin coral underline), and those are what this reads.
 *
 * It answers one of three things, and never guesses:
 *   matched    one look fits clearly and no other does
 *   ambiguous  there is caption-like white text, but the evidence fits no look, or two equally (a model may label it)
 *   none       no caption-like text in any frame
 *
 * Everything it sees in a frame is treated as pixels to measure, never as words to read.
 */

export interface Frame {
  width: number
  height: number
  /** Packed rgb24, row by row. */
  rgb: Uint8Array
}

/** The colours the editor uses for the spoken word, from frontend/src/features/editor/captionStyles.ts (a test checks they still match). */
export const ACCENTS = {
  saffron: '#ffa83a',
  yellow: '#ffe14a',
  teal: '#5fcdbb',
  coral: '#ff7a5c',
} as const
type Accent = keyof typeof ACCENTS
const ACCENT_NAMES = Object.keys(ACCENTS) as Accent[]
const ACCENT_RGB = Object.fromEntries(ACCENT_NAMES.map((a) => [a, fromHex(ACCENTS[a])])) as Record<
  Accent,
  Rgb
>
const ACCENT_HUE = Object.fromEntries(ACCENT_NAMES.map((a) => [a, hsv(ACCENT_RGB[a]).h])) as Record<
  Accent,
  number
>

/** How close (in RGB) a pixel is to an accent to count as that accent, and how far its hue may be to count as a glow of it. */
const STRONG_DISTANCE = 55
const SOFT_HUE_GAP = 22

/** Where the editor puts captions, as a share of the frame's height. */
const BANDS = {
  lower: [0.58, 0.9],
  center: [0.36, 0.64],
} as const
type BandName = keyof typeof BANDS

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface AccentStats {
  /** Share of the band's pixels that are this accent. */
  frac: number
  /** The pixels' bounding box, and how much of it they fill (a pill fills it; text and an underline do not). */
  box: Box | null
  fill: number
  /** Sum of the pixels' colour, to name the colour that was really there. */
  sum: Rgb
  count: number
}

interface Band {
  white: number
  accents: Record<Accent, AccentStats>
  /** Share of the band's pixels that are a soft, blurred version of an accent (a glow). */
  glow: Record<Accent, number>
  darkBox: boolean
  /** Of the white pixels, the share that touch a dark one: a black outline does that. */
  stroke: number
}

const isWhite = (r: number, g: number, b: number) => r >= 225 && g >= 225 && b >= 225

function analyseBand(frame: Frame, name: BandName): Band {
  const { width: W, height: H, rgb } = frame
  const y0 = Math.floor(H * BANDS[name][0])
  const y1 = Math.min(H, Math.ceil(H * BANDS[name][1]))
  const rows = y1 - y0
  const area = W * rows

  const acc = Object.fromEntries(
    ACCENT_NAMES.map((a) => [a, { n: 0, x0: W, y0: H, x1: -1, y1: -1, r: 0, g: 0, b: 0 }]),
  ) as Record<
    Accent,
    { n: number; x0: number; y0: number; x1: number; y1: number; r: number; g: number; b: number }
  >
  const glow = Object.fromEntries(ACCENT_NAMES.map((a) => [a, 0])) as Record<Accent, number>
  const dark = new Uint8Array(area)
  const white = new Uint8Array(area)
  let whiteCount = 0

  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const r = rgb[i]!
      const g = rgb[i + 1]!
      const b = rgb[i + 2]!
      const k = (y - y0) * W + x
      if (isWhite(r, g, b)) {
        white[k] = 1
        whiteCount++
        continue
      }
      const px: Rgb = [r, g, b]
      if (luma(px) < 45) {
        dark[k] = 1
        continue
      }
      let best: Accent | null = null
      let bestD = STRONG_DISTANCE
      for (const a of ACCENT_NAMES) {
        const d = distance(px, ACCENT_RGB[a])
        if (d <= bestD) {
          bestD = d
          best = a
        }
      }
      if (best) {
        const s = acc[best]
        s.n++
        s.r += r
        s.g += g
        s.b += b
        if (x < s.x0) s.x0 = x
        if (x > s.x1) s.x1 = x
        if (y < s.y0) s.y0 = y
        if (y > s.y1) s.y1 = y
        continue
      }
      const c = hsv(px)
      if (c.s >= 0.3 && c.v >= 0.35)
        for (const a of ACCENT_NAMES) if (hueGap(c.h, ACCENT_HUE[a]) <= SOFT_HUE_GAP) glow[a]++
    }
  }

  const accents = Object.fromEntries(
    ACCENT_NAMES.map((a) => {
      const s = acc[a]
      const box = s.n ? { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 } : null
      const boxArea = box ? (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) : 0
      return [
        a,
        {
          frac: s.n / area,
          box,
          fill: boxArea ? s.n / boxArea : 0,
          sum: [s.r, s.g, s.b] as Rgb,
          count: s.n,
        },
      ]
    }),
  ) as Record<Accent, AccentStats>
  for (const a of ACCENT_NAMES) glow[a] /= area

  return {
    white: whiteCount / area,
    accents,
    glow,
    darkBox: findDarkBox(dark, white, W, rows),
    stroke: strokeShare(dark, white, W, rows),
  }
}

/** A dark rectangle, narrower than the frame, with white on it: the box behind boxed captions. */
function findDarkBox(dark: Uint8Array, white: Uint8Array, W: number, rows: number): boolean {
  const rowDark = new Array<number>(rows).fill(0)
  for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) rowDark[y]! += dark[y * W + x]!
  // The longest run of rows that are at least a fifth dark.
  let best = { from: 0, to: -1 }
  let from = -1
  for (let y = 0; y <= rows; y++) {
    const on = y < rows && rowDark[y]! >= W * 0.2
    if (on && from < 0) from = y
    if (!on && from >= 0) {
      if (y - 1 - from > best.to - best.from) best = { from, to: y - 1 }
      from = -1
    }
  }
  const height = best.to - best.from + 1
  if (height < rows * 0.1) return false
  // The columns that are dark through most of that run.
  let x0 = -1
  let x1 = -1
  for (let x = 0; x < W; x++) {
    let n = 0
    for (let y = best.from; y <= best.to; y++) n += dark[y * W + x]! || white[y * W + x]!
    if (n >= height * 0.7) {
      if (x0 < 0) x0 = x
      x1 = x
    }
  }
  if (x0 < 0) return false
  const span = x1 - x0 + 1
  if (span < W * 0.25 || span > W * 0.92) return false
  let inside = 0
  let darkInside = 0
  let whiteInside = 0
  let outsideDark = 0
  let outside = 0
  for (let y = best.from; y <= best.to; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x
      if (x >= x0 && x <= x1) {
        inside++
        darkInside += dark[k]!
        whiteInside += white[k]!
      } else {
        outside++
        outsideDark += dark[k]!
      }
    }
  return (
    (darkInside + whiteInside) / inside >= 0.75 &&
    whiteInside / inside >= 0.005 &&
    // Outside the box the picture is not dark too: a dark background is not a box.
    (outside === 0 || outsideDark / outside <= 0.6)
  )
}

function strokeShare(dark: Uint8Array, white: Uint8Array, W: number, rows: number): number {
  let whites = 0
  let touching = 0
  for (let y = 2; y < rows - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      const k = y * W + x
      if (!white[k]) continue
      whites++
      if (dark[k - 2] || dark[k + 2] || dark[k - 2 * W] || dark[k + 2 * W]) touching++
    }
  return whites ? touching / whites : 0
}

/** The looks the rules can tell apart, and what each needs to be seen in a frame. */
type Evidence = (bands: Record<BandName, Band>, frame: Frame) => boolean
const heightShare = (box: Box | null, H: number) => (box ? (box.y1 - box.y0 + 1) / H : 0)
const WHITE_SEEN = 0.002

export const RULES: Record<string, Evidence> = {
  'saffron-pop': ({ lower: l }, f) =>
    l.accents.saffron.frac >= 0.004 &&
    l.accents.saffron.fill >= 0.45 &&
    heightShare(l.accents.saffron.box, f.height) >= 0.02 &&
    l.white >= WHITE_SEEN &&
    !l.darkBox,
  boxed: ({ lower: l }) => l.darkBox,
  karaoke: ({ lower: l }) =>
    l.accents.teal.frac >= 0.003 &&
    l.accents.teal.fill < 0.45 &&
    l.white >= WHITE_SEEN &&
    !l.darkBox,
  neon: ({ lower: l }) =>
    l.glow.teal >= 0.008 && l.accents.teal.frac < 0.002 && l.white >= WHITE_SEEN && !l.darkBox,
  outline: ({ center: c }) =>
    c.accents.yellow.frac >= 0.003 && c.white >= WHITE_SEEN && c.stroke >= 0.25,
  'coral-bounce': ({ center: c }, f) =>
    c.accents.coral.frac >= 0.004 &&
    c.accents.coral.fill >= 0.45 &&
    heightShare(c.accents.coral.box, f.height) >= 0.02,
  typewriter: ({ lower: l }, f) => {
    const box = l.accents.coral.box
    if (!box || l.accents.coral.frac < 0.001 || l.white < WHITE_SEEN) return false
    const h = box.y1 - box.y0 + 1
    return (box.x1 - box.x0 + 1) / h >= 8 && h / f.height <= 0.025
  },
}

export type CaptionRead =
  | { status: 'none'; styleId: null; colors: string[] }
  | { status: 'matched'; styleId: string; confidence: number; colors: string[] }
  | { status: 'ambiguous'; styleId: null; candidates: string[]; colors: string[] }

/** Frames that show the style in this share of the frames that show any caption-like text count as the Reel's look. */
const MATCH_SHARE = 0.5
const MIN_FRAMES = 2

export function readCaptions(frames: Frame[]): CaptionRead {
  const hits = new Map<string, number>()
  let withText = 0
  const colorSum = new Map<Accent, { n: number; sum: Rgb }>()
  let whiteFrames = 0

  for (const frame of frames) {
    const bands = { lower: analyseBand(frame, 'lower'), center: analyseBand(frame, 'center') }
    const text = bands.lower.white >= WHITE_SEEN || bands.center.white >= WHITE_SEEN
    let any = false
    for (const [id, rule] of Object.entries(RULES)) {
      if (rule(bands, frame)) {
        hits.set(id, (hits.get(id) ?? 0) + 1)
        any = true
      }
    }
    if (text || any) withText++
    if (text) whiteFrames++
    for (const b of [bands.lower, bands.center])
      for (const a of ACCENT_NAMES) {
        const s = b.accents[a]
        if (s.frac < 0.001) continue
        const cur = colorSum.get(a) ?? { n: 0, sum: [0, 0, 0] as Rgb }
        cur.n += s.count
        cur.sum = [cur.sum[0] + s.sum[0], cur.sum[1] + s.sum[1], cur.sum[2] + s.sum[2]]
        colorSum.set(a, cur)
      }
  }

  const colors = [...colorSum.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([, v]) => hex([v.sum[0] / v.n, v.sum[1] / v.n, v.sum[2] / v.n]))
  if (whiteFrames >= frames.length * 0.5) colors.push('#ffffff')

  if (withText < MIN_FRAMES) return { status: 'none', styleId: null, colors: [] }

  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const [best, second] = ranked
  if (best && best[1] >= MIN_FRAMES && best[1] / withText >= MATCH_SHARE) {
    // Two looks both seen in most frames is not a match for either.
    if (!second || second[1] < best[1] * 0.75)
      return {
        status: 'matched',
        styleId: best[0],
        confidence: Math.round((best[1] / withText) * 100) / 100,
        colors: colors.slice(0, 4),
      }
  }
  return {
    status: 'ambiguous',
    styleId: null,
    candidates: ranked.map(([id]) => id),
    colors: colors.slice(0, 4),
  }
}
