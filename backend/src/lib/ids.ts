import { randomBytes } from 'node:crypto'

/**
 * UUID v7: a timestamp prefix keeps new rows adjacent in the primary-key index, which is
 * kinder to Postgres than random v4 ids, and ids sort by creation time.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16)
  b[0] = (now / 2 ** 40) & 0xff
  b[1] = (now / 2 ** 32) & 0xff
  b[2] = (now / 2 ** 24) & 0xff
  b[3] = (now / 2 ** 16) & 0xff
  b[4] = (now / 2 ** 8) & 0xff
  b[5] = now & 0xff
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
