import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createVault,
  DEVELOPMENT_KEY,
  parseVaultKey,
  TokenVault,
  VaultError,
  type VaultKey,
} from '../../src/style/instagram/vault.js'

const key = (id: string): VaultKey => ({ id, key: randomBytes(32) })
const TOKEN = 'IGAAxyz123-secret-token-value'
const OWNER = '0190c8a1-0000-7000-8000-000000000001'

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof VaultError ? e.code : `not a VaultError: ${String(e)}`
  }
  return undefined
}

describe('sealing and opening a token', () => {
  it('opens what it sealed, and the sealed form shows nothing of the token', () => {
    const vault = new TokenVault(key('k1'))
    const { envelope, keyId } = vault.seal(TOKEN, OWNER)
    expect(keyId).toBe('k1')
    expect(vault.open(envelope, OWNER)).toBe(TOKEN)
    expect(envelope).not.toContain(TOKEN)
    expect(envelope).not.toContain(Buffer.from(TOKEN).toString('base64'))
    expect(envelope.split('.')).toHaveLength(4)
    expect(envelope.startsWith('v1.k1.')).toBe(true)
  })

  it('uses a fresh nonce every time, so the same token never seals the same way twice', () => {
    const vault = new TokenVault(key('k1'))
    const a = vault.seal(TOKEN, OWNER).envelope
    const b = vault.seal(TOKEN, OWNER).envelope
    expect(a).not.toBe(b)
    const nonces = new Set(
      Array.from({ length: 200 }, () => vault.seal(TOKEN, OWNER).envelope.split('.')[2]),
    )
    expect(nonces.size).toBe(200)
  })

  it('handles long and non-ASCII tokens, and refuses to seal nothing', () => {
    const vault = new TokenVault(key('k1'))
    const long = 'IG' + 'x'.repeat(5000) + 'é्'
    expect(vault.open(vault.seal(long, OWNER).envelope, OWNER)).toBe(long)
    expect(codeOf(() => vault.seal('', OWNER))).toBe('empty')
  })
})

describe('what it refuses to open', () => {
  it('a different key with the same id', () => {
    const sealed = new TokenVault({ id: 'k1', key: randomBytes(32) }).seal(TOKEN, OWNER).envelope
    const other = new TokenVault({ id: 'k1', key: randomBytes(32) })
    expect(codeOf(() => other.open(sealed, OWNER))).toBe('cannot_open')
  })

  it('a token whose key is not configured at all', () => {
    const sealed = new TokenVault(key('k1')).seal(TOKEN, OWNER).envelope
    expect(codeOf(() => new TokenVault(key('k2')).open(sealed, OWNER))).toBe('unknown_key')
  })

  it('a token changed anywhere: nonce, ciphertext, tag, or the key id in front of it', () => {
    const vault = new TokenVault(key('k1'))
    const [v, id, nonce, body] = vault.seal(TOKEN, OWNER).envelope.split('.') as [
      string,
      string,
      string,
      string,
    ]
    const flip = (b64: string, at: number) => {
      const buf = Buffer.from(b64, 'base64url')
      buf[at] = buf[at]! ^ 1
      return buf.toString('base64url')
    }
    const lastByte = Buffer.from(body, 'base64url').length - 1
    const tampered = [
      [v, id, flip(nonce, 0), body],
      [v, id, nonce, flip(body, 0)],
      [v, id, nonce, flip(body, lastByte)],
    ]
    for (const parts of tampered)
      expect(codeOf(() => vault.open(parts.join('.'), OWNER))).toBe('cannot_open')
    // The key id is authenticated too: renaming the key to another configured one does not open it.
    const two = new TokenVault(key('k1'), [{ id: 'k2', key: randomBytes(32) }])
    const sealed = two.seal(TOKEN, OWNER).envelope.split('.')
    sealed[1] = 'k2'
    expect(codeOf(() => two.open(sealed.join('.'), OWNER))).toBe('cannot_open')
  })

  it('one person’s sealed token on another person’s row', () => {
    const vault = new TokenVault(key('k1'))
    const sealed = vault.seal(TOKEN, OWNER).envelope
    expect(codeOf(() => vault.open(sealed, '0190c8a1-0000-7000-8000-000000000002'))).toBe(
      'cannot_open',
    )
  })

  it('anything that is not an envelope', () => {
    const vault = new TokenVault(key('k1'))
    for (const junk of [
      '',
      'abc',
      'v1.k1.x.y',
      'v2.k1.AAAA.AAAA',
      'v1..a.b',
      `v1.k1.${'A'.repeat(16)}.AAAA`,
      TOKEN,
    ])
      expect(
        codeOf(() => vault.open(junk, OWNER)),
        junk,
      ).toBe('malformed')
  })

  it('and its errors never contain the token, the key or the sealed string', () => {
    const k = key('k1')
    const vault = new TokenVault(k)
    const sealed = vault.seal(TOKEN, OWNER).envelope
    const messages: string[] = []
    for (const fn of [
      () => new TokenVault({ id: 'k1', key: randomBytes(32) }).open(sealed, OWNER),
      () => vault.open(sealed, 'someone-else'),
      () => vault.open(sealed.replace('.k1.', '.zz.'), OWNER),
      () => vault.open(sealed.slice(0, -4), OWNER),
    ]) {
      try {
        fn()
      } catch (e) {
        messages.push(String(e instanceof Error ? e.message : e))
      }
    }
    expect(messages).toHaveLength(4)
    for (const m of messages) {
      expect(m).not.toContain(TOKEN)
      expect(m).not.toContain(k.key.toString('base64'))
      expect(m).not.toContain(sealed.split('.')[3])
    }
  })
})

describe('rotating the key', () => {
  it('a token sealed with the old key still opens once the new key is current, and is re-sealed with the new one', () => {
    const oldKey = key('k1')
    const newKey = key('k2')
    const sealed = new TokenVault(oldKey).seal(TOKEN, OWNER).envelope

    const rotated = new TokenVault(newKey, [oldKey])
    expect(rotated.open(sealed, OWNER)).toBe(TOKEN)
    expect(rotated.needsRotation(sealed)).toBe(true)

    const again = rotated.rotate(sealed, OWNER)
    expect(again.keyId).toBe('k2')
    expect(again.envelope.startsWith('v1.k2.')).toBe(true)
    expect(rotated.needsRotation(again.envelope)).toBe(false)
    expect(rotated.open(again.envelope, OWNER)).toBe(TOKEN)

    // Once nothing is sealed with the old key, it can be dropped.
    const final = new TokenVault(newKey)
    expect(final.open(again.envelope, OWNER)).toBe(TOKEN)
    expect(codeOf(() => final.open(sealed, OWNER))).toBe('unknown_key')
  })

  it('refuses two keys with one id, and keys of the wrong size', () => {
    expect(codeOf(() => new TokenVault(key('k1'), [key('k1')]))).toBe('bad_key')
    expect(codeOf(() => new TokenVault({ id: 'k1', key: randomBytes(16) }))).toBe('bad_key')
  })
})

describe('key settings', () => {
  const good = `k1:${randomBytes(32).toString('base64')}`

  it('parses id:base64 into a 32-byte key', () => {
    const k = parseVaultKey(good)
    expect(k.id).toBe('k1')
    expect(k.key).toHaveLength(32)
    expect(parseVaultKey(DEVELOPMENT_KEY).id).toBe('dev')
  })

  it('refuses a key without an id, with a bad id, or of the wrong length', () => {
    for (const bad of [
      '',
      'nokey',
      `:${good.slice(3)}`,
      `bad id:${good.slice(3)}`,
      'k1:c2hvcnQ=',
      `${'x'.repeat(40)}:${good.slice(3)}`,
    ])
      expect(
        codeOf(() => parseVaultKey(bad)),
        bad,
      ).toBe('bad_key')
  })

  it('builds a vault from settings: the development key when none is set, old keys after the current one', () => {
    expect(createVault({ TOKEN_ENCRYPTION_OLD_KEYS: [] }).currentKeyId).toBe('dev')
    const old = `k0:${randomBytes(32).toString('base64')}`
    const sealed = createVault({ TOKEN_ENCRYPTION_KEY: old, TOKEN_ENCRYPTION_OLD_KEYS: [] }).seal(
      TOKEN,
      OWNER,
    ).envelope
    const vault = createVault({ TOKEN_ENCRYPTION_KEY: good, TOKEN_ENCRYPTION_OLD_KEYS: [old] })
    expect(vault.currentKeyId).toBe('k1')
    expect(vault.open(sealed, OWNER)).toBe(TOKEN)
  })
})
