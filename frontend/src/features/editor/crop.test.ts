import { describe, expect, it } from 'vitest'
import { clampCrop, cropAt, cropWindow, videoBox } from './crop'

describe('crop', () => {
  it('9:16 window of a 16:9 frame is full height and about a third wide', () => {
    const w = cropWindow({ x: 0.5, y: 0.5, scale: 1 }, '9:16')
    expect(w.h).toBe(1)
    expect(w.w).toBeCloseTo(0.3164, 3)
    expect(w.x).toBeCloseTo(0.5 - 0.3164 / 2, 3)
  })

  it('keeps the window inside the frame', () => {
    const w = cropWindow({ x: 0, y: 0, scale: 1 }, '9:16')
    expect(w.x).toBe(0)
    const c = clampCrop({ x: 1, y: 0.5, scale: 1 }, '9:16')
    expect(c.x).toBeCloseTo(1 - 0.3164 / 2, 3)
  })

  it('zooming in shrinks the window', () => {
    const w = cropWindow({ x: 0.5, y: 0.5, scale: 2 }, '9:16')
    expect(w.h).toBe(0.5)
    expect(w.w).toBeCloseTo(0.1582, 3)
  })

  it('16:9 output of a 16:9 source is the whole frame', () => {
    const w = cropWindow({ x: 0.5, y: 0.5, scale: 1 }, '16:9')
    expect(w).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('places the video so the window fills the container', () => {
    const b = videoBox({ x: 0.25, y: 0, w: 0.25, h: 1 })
    expect(b.width).toBe('400%')
    expect(b.left).toBe('-100%')
  })

  it('interpolates keyframes', () => {
    const s = {
      crop: { x: 0.5, y: 0.5, scale: 1 },
      keyframes: [
        { t: 0, x: 0.2, y: 0.5, scale: 1 },
        { t: 10, x: 0.6, y: 0.5, scale: 2 },
      ],
    }
    expect(cropAt(s, 5)).toEqual({ x: 0.4, y: 0.5, scale: 1.5 })
    expect(cropAt(s, -1).x).toBe(0.2)
    expect(cropAt(s, 20).x).toBe(0.6)
    expect(cropAt({ crop: s.crop, keyframes: [] }, 3)).toBe(s.crop)
  })
})
