import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readSignedRequest, signRequest } from '../../src/style/instagram/deletion.js'

const SECRET = 'app-secret-for-tests'
const sign = (payload: Record<string, unknown>) => signRequest(payload, SECRET)
const resign = (payload: unknown, secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`
}

describe('the signed request Meta sends', () => {
  it('is accepted when it is signed with the app secret, and gives the account to delete', () => {
    expect(readSignedRequest(sign({ user_id: '17841400000000001' }), SECRET)).toEqual({
      userId: '17841400000000001',
    })
    expect(readSignedRequest(sign({ user_id: 1784140000000 }), SECRET)?.userId).toMatch(/^\d+$/)
  })

  it('is refused when it was signed with another secret, or changed anywhere', () => {
    const good = sign({ user_id: '123' })
    expect(readSignedRequest(good, 'another-secret')).toBeNull()
    const [sig, payload] = good.split('.') as [string, string]
    const other = Buffer.from(
      JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '999' }),
    ).toString('base64url')
    expect(readSignedRequest(`${sig}.${other}`, SECRET)).toBeNull()
    const flipped = Buffer.from(sig, 'base64url')
    flipped[0] = flipped[0]! ^ 1
    expect(readSignedRequest(`${flipped.toString('base64url')}.${payload}`, SECRET)).toBeNull()
    expect(readSignedRequest(`${sig.slice(0, -2)}.${payload}`, SECRET)).toBeNull()
    expect(readSignedRequest(`${sig}AA.${payload}`, SECRET)).toBeNull()
  })

  it('is refused when it is not in the form at all', () => {
    for (const junk of [
      undefined,
      null,
      5,
      {},
      [],
      '',
      '.',
      'a',
      'a.b.c',
      '.payload',
      'sig.',
      'sig . payload',
      `${'a'.repeat(5000)}.b`,
    ])
      expect(readSignedRequest(junk, SECRET), String(junk)).toBeNull()
  })

  it('is refused unless it says HMAC-SHA256, even if the signature is right', () => {
    expect(readSignedRequest(resign({ algorithm: 'HMAC-SHA1', user_id: '1' }), SECRET)).toBeNull()
    expect(readSignedRequest(resign({ algorithm: 'none', user_id: '1' }), SECRET)).toBeNull()
    expect(readSignedRequest(resign({ user_id: '1' }), SECRET)).toBeNull()
    expect(readSignedRequest(resign({ algorithm: 'hmac-sha256', user_id: '1' }), SECRET)).toEqual({
      userId: '1',
    })
  })

  it('is refused unless it names an account by digits only', () => {
    for (const user_id of [
      undefined,
      null,
      '',
      'abc',
      '12 34',
      '1; drop table users',
      '-5',
      '1.5',
      'x'.repeat(40),
      {},
      [1],
      true,
    ])
      expect(
        readSignedRequest(resign({ algorithm: 'HMAC-SHA256', user_id }), SECRET),
        String(user_id),
      ).toBeNull()
  })

  it('is refused when the payload is not JSON, or not an object', () => {
    expect(readSignedRequest(resign('just a string'), SECRET)).toBeNull()
    expect(readSignedRequest(resign(null), SECRET)).toBeNull()
    const body = Buffer.from('not json').toString('base64url')
    expect(
      readSignedRequest(
        `${createHmac('sha256', SECRET).update(body).digest('base64url')}.${body}`,
        SECRET,
      ),
    ).toBeNull()
  })
})
