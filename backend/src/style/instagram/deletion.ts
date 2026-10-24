import { createHmac, timingSafeEqual } from 'node:crypto'

/** The most a signed request may be: Meta's are a few hundred bytes. */
const MAX_LENGTH = 4096

export interface DeletionRequest {
  /** The Instagram account whose data is to be deleted. */
  userId: string
}

const b64 = (s: string) => Buffer.from(s, 'base64url')

/**
 * Checks and reads the `signed_request` Meta sends to the data-deletion callback: `<signature>.<payload>`, both base64url, the
 * signature being HMAC-SHA256 of the payload text with the app secret. Compared in constant time. Returns null for anything that is
 * not exactly that, signed with this app's secret: nothing is trusted, and nothing is reported about why.
 *
 * (The format is from Meta's documentation of signed requests and the community's reports of this callback; the official
 * page for the callback itself could not be read. The code is the only thing that knows it.)
 */
export function readSignedRequest(raw: unknown, appSecret: string): DeletionRequest | null {
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return null
  const parts = raw.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const [signature, payload] = parts as [string, string]
  if (!/^[A-Za-z0-9_-]+$/.test(signature) || !/^[A-Za-z0-9_-]+$/.test(payload)) return null

  const expected = createHmac('sha256', appSecret).update(payload).digest()
  const given = b64(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let data: unknown
  try {
    data = JSON.parse(b64(payload).toString('utf8'))
  } catch {
    return null
  }
  const d = data as { algorithm?: unknown; user_id?: unknown }
  if (typeof d !== 'object' || d === null) return null
  // Only the algorithm the signature was made with.
  if (typeof d.algorithm !== 'string' || d.algorithm.toUpperCase() !== 'HMAC-SHA256') return null
  const userId = typeof d.user_id === 'number' ? String(d.user_id) : d.user_id
  if (typeof userId !== 'string' || !/^\d{1,30}$/.test(userId)) return null
  return { userId }
}

/** Makes a signed request: what Meta does, for tests and for trying the callback by hand. */
export function signRequest(payload: Record<string, unknown>, appSecret: string): string {
  const body = Buffer.from(
    JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: 1_700_000_000, ...payload }),
  ).toString('base64url')
  return `${createHmac('sha256', appSecret).update(body).digest('base64url')}.${body}`
}
