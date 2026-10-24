import { useSyncExternalStore } from 'react'

/**
 * The one playback clock. The player, the timeline playhead, the transcript highlight, the
 * captions and the phone preview all read time from here and nowhere else, so they cannot drift.
 *
 * Time is TIMELINE time in seconds. Anything that needs source time maps through the timeline.
 *
 * Two ways to listen:
 *  - `onFrame(fn)`: imperative, every tick. For DOM-driven things (playhead, video element)
 *    that must not re-render React 60 times a second.
 *  - `useClock(selector)`: React hook. The selector must return a primitive; the component
 *    re-renders only when that primitive changes (for example the current word index).
 */
type Frame = (time: number, playing: boolean) => void

export class Clock {
  private t = 0
  private dur = 0
  private isPlaying = false
  private raf = 0
  private last = 0
  rate = 1
  private react = new Set<() => void>()
  private frames = new Set<Frame>()
  private readonly request: (cb: (now: number) => void) => number
  private readonly cancel: (id: number) => void

  constructor(
    request: (cb: (now: number) => void) => number = (cb) => requestAnimationFrame(cb),
    cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {
    this.request = request
    this.cancel = cancel
  }

  get time() {
    return this.t
  }
  get duration() {
    return this.dur
  }
  get playing() {
    return this.isPlaying
  }

  setDuration(d: number) {
    this.dur = Math.max(0, d)
    if (this.t > this.dur) this.set(this.dur)
    else this.emit()
  }

  seek(t: number) {
    this.set(t)
  }

  play() {
    if (this.isPlaying || this.dur <= 0) return
    if (this.t >= this.dur - 0.05) this.t = 0
    this.isPlaying = true
    this.last = 0
    this.raf = this.request(this.loop)
    this.emit()
  }

  pause() {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.cancel(this.raf)
    this.emit()
  }

  toggle() {
    if (this.isPlaying) this.pause()
    else this.play()
  }

  /** Advance by `dt` seconds. Used by the loop, and directly by tests. */
  advance(dt: number) {
    if (!this.isPlaying) return
    const next = this.t + dt * this.rate
    if (next >= this.dur) {
      this.t = this.dur
      this.isPlaying = false
      this.cancel(this.raf)
    } else this.t = next
    this.emit()
  }

  private loop = (now: number) => {
    if (!this.isPlaying) return
    if (this.last) this.advance(Math.min(0.1, (now - this.last) / 1000))
    this.last = now
    if (this.isPlaying) this.raf = this.request(this.loop)
  }

  private set(t: number) {
    this.t = Math.min(this.dur, Math.max(0, t))
    this.emit()
  }

  private emit() {
    this.frames.forEach((f) => f(this.t, this.isPlaying))
    this.react.forEach((f) => f())
  }

  onFrame(fn: Frame): () => void {
    this.frames.add(fn)
    return () => this.frames.delete(fn)
  }

  subscribe = (fn: () => void): (() => void) => {
    this.react.add(fn)
    return () => this.react.delete(fn)
  }
}

export const clock = new Clock()

/** Read a primitive derived from the clock. Re-renders only when the primitive changes. */
export function useClock<T extends string | number | boolean | undefined>(
  select: (time: number, playing: boolean) => T,
): T {
  return useSyncExternalStore(
    clock.subscribe,
    () => select(clock.time, clock.playing),
    () => select(0, false),
  )
}
