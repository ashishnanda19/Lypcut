import { describe, expect, it } from 'vitest'
import { formatDuration, formatRange, formatTimecode } from './time'

describe('time formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('never goes negative', () => {
    expect(formatDuration(-4)).toBe('0:00')
    expect(formatTimecode(-1)).toBe('00:00.0')
  })

  it('formats timecodes with tenths', () => {
    expect(formatTimecode(9.4)).toBe('00:09.4')
    expect(formatTimecode(124.49)).toBe('02:04.4')
  })

  it('formats ranges', () => {
    expect(formatRange(72, 109)).toBe('1:12 – 1:49')
  })
})
