import { describe, expect, it } from 'vitest'
import { UUID_RE, uuidv7 } from '../../src/lib/ids.js'

describe('uuidv7', () => {
  it('has the v7 layout', () => {
    const id = uuidv7()
    expect(id).toMatch(UUID_RE)
    expect(id[14]).toBe('7')
    expect('89ab').toContain(id[19])
  })

  it('embeds the timestamp so ids sort by creation time', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_001_000)
    expect(a < b).toBe(true)
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()))
    expect(ids.size).toBe(5000)
  })
})
