import type { AspectId, CropState, TimelineSettings } from '@/types'

export const SOURCE_ASPECT = 16 / 9

const RATIOS: Record<AspectId, number> = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 }
export const aspectRatio = (id: AspectId) => RATIOS[id]

export interface CropWindow {
  /** Left, top, width and height as fractions of the source frame. */
  x: number
  y: number
  w: number
  h: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The part of the source frame that ends up in the reel. */
export function cropWindow(
  crop: CropState,
  aspect: AspectId,
  srcAspect = SOURCE_ASPECT,
): CropWindow {
  const r = aspectRatio(aspect)
  let h = 1 / Math.max(1, crop.scale)
  let w = (r * h) / srcAspect
  if (w > 1) {
    w = 1
    h = Math.min(1, (w * srcAspect) / r)
  }
  return { x: clamp(crop.x - w / 2, 0, 1 - w), y: clamp(crop.y - h / 2, 0, 1 - h), w, h }
}

/** Keep a dragged centre inside the frame. */
export function clampCrop(crop: CropState, aspect: AspectId, srcAspect = SOURCE_ASPECT): CropState {
  const win = cropWindow(crop, aspect, srcAspect)
  return { ...crop, x: win.x + win.w / 2, y: win.y + win.h / 2, scale: clamp(crop.scale, 1, 3) }
}

/** Crop at a moment: the keyframes (linear) if there are any, otherwise the single crop. */
export function cropAt(
  settings: Pick<TimelineSettings, 'crop' | 'keyframes'>,
  t: number,
): CropState {
  const ks = settings.keyframes
  if (!ks.length) return settings.crop
  if (t <= ks[0]!.t) return ks[0]!
  const last = ks[ks.length - 1]!
  if (t >= last.t) return last
  for (let i = 1; i < ks.length; i++) {
    const b = ks[i]!
    if (t <= b.t) {
      const a = ks[i - 1]!
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t)
      return {
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        scale: a.scale + (b.scale - a.scale) * k,
      }
    }
  }
  return last
}

/** CSS percentages that place a full-frame video so only the window shows inside its container. */
export function videoBox(win: CropWindow) {
  return {
    width: `${100 / win.w}%`,
    height: `${100 / win.h}%`,
    left: `${(-win.x / win.w) * 100}%`,
    top: `${(-win.y / win.h) * 100}%`,
  }
}
