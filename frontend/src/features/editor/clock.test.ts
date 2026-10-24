import { describe, expect, it, vi } from 'vitest'
import { Clock } from './clock'

function make() {
  let cb: ((n: number) => void) | null = null
  const c = new Clock(
    (f) => {
      cb = f
      return 1
    },
    () => {
      cb = null
    },
  )
  return { c, frame: (now: number) => cb?.(now) }
}

describe('Clock', () => {
  it('seeks within bounds and notifies listeners', () => {
    const { c } = make()
    c.setDuration(10)
    const f = vi.fn()
    c.onFrame(f)
    c.seek(4)
    c.seek(99)
    c.seek(-3)
    expect(f.mock.calls.map((x) => x[0])).toEqual([4, 10, 0])
  })

  it('plays, advances by real elapsed time and stops at the end', () => {
    const { c, frame } = make()
    c.setDuration(2)
    c.play()
    frame(1000)
    frame(1050)
    expect(c.time).toBeCloseTo(0.05)
    for (let i = 1; i <= 26; i++) frame(1050 + i * 80)
    expect(c.time).toBe(2)
    expect(c.playing).toBe(false)
  })

  it('caps a long frame gap so a background tab does not jump ahead', () => {
    const { c, frame } = make()
    c.setDuration(100)
    c.play()
    frame(1000)
    frame(60_000)
    expect(c.time).toBeCloseTo(0.1)
  })

  it('restarts from zero when played at the end', () => {
    const { c } = make()
    c.setDuration(5)
    c.seek(5)
    c.play()
    expect(c.time).toBe(0)
    expect(c.playing).toBe(true)
  })

  it('clamps time when the duration shrinks', () => {
    const { c } = make()
    c.setDuration(10)
    c.seek(8)
    c.setDuration(6)
    expect(c.time).toBe(6)
  })

  it('does not play with an empty timeline', () => {
    const { c } = make()
    c.play()
    expect(c.playing).toBe(false)
  })
})
