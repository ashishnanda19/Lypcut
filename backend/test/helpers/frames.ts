import type { Frame } from '../../src/style/analysis/captions.js'
import { fromHex } from '../../src/style/analysis/palette.js'

export const W = 270
export const H = 480

type Rgb = [number, number, number]

/** A mid-grey frame with a gentle gradient, like footage that is neither dark nor bright. */
export function footage(): Frame {
  const rgb = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      rgb[i] = 90 + ((x * 20) >> 8)
      rgb[i + 1] = 100 + ((y * 20) >> 9)
      rgb[i + 2] = 110
    }
  return { width: W, height: H, rgb }
}

export function rect(
  f: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string | Rgb,
): Frame {
  const [r, g, b] = typeof color === 'string' ? fromHex(color) : color
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * f.width + xx) * 3
      f.rgb[i] = r
      f.rgb[i + 1] = g
      f.rgb[i + 2] = b
    }
  return f
}

/** A line of "text": white blocks the size of letters. */
export function text(
  f: Frame,
  x: number,
  y: number,
  letters = 14,
  color: string = '#ffffff',
): Frame {
  for (let i = 0; i < letters; i++) rect(f, x + i * 11, y, 8, 15, color)
  return f
}

const lower = 360
const center = 230

/** One frame showing each of the editor's caption looks, drawn the way the editor draws it. */
export const looks = {
  'saffron-pop': () => {
    const f = footage()
    rect(f, 130, lower - 6, 34, 28, '#ffa83a')
    return text(f, 60, lower)
  },
  boxed: () => {
    const f = footage()
    rect(f, 40, lower - 12, 190, 42, [8, 10, 14])
    return text(f, 62, lower, 14)
  },
  karaoke: () => {
    const f = footage()
    for (let i = 0; i < 22; i++) rect(f, 60 + i * 7, lower, 3, 15, '#5fcdbb')
    return text(f, 60, lower + 22, 14)
  },
  neon: () => {
    const f = footage()
    rect(f, 50, lower - 14, 170, 46, [60, 120, 115])
    return text(f, 62, lower, 14, '#eaf9f6')
  },
  outline: () => {
    const f = footage()
    rect(f, 50, center - 4, 170, 24, [0, 0, 0])
    text(f, 62, center, 14)
    for (let i = 0; i < 6; i++) rect(f, 62 + i * 11, center + 2, 3, 12, '#ffe14a')
    return f
  },
  'coral-bounce': () => {
    const f = footage()
    rect(f, 110, center - 6, 50, 30, '#ff7a5c')
    return text(f, 60, center)
  },
  typewriter: () => {
    const f = footage()
    text(f, 60, lower)
    return rect(f, 60, lower + 22, 150, 4, '#ff7a5c')
  },
} as const

/** Plain white text over footage, which fits no look in particular. */
export const plainWhite = () => text(footage(), 60, lower)
export const noCaptions = () => footage()
