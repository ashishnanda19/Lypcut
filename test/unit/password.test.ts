import argon2 from 'argon2'
import { describe, expect, it } from 'vitest'
import { hashPassword, needsRehash, verifyPassword } from '../../src/lib/password.js'

describe('passwords', () => {
  it('hash with argon2id and a unique salt', async () => {
    const a = await hashPassword('correct horse battery')
    const b = await hashPassword('correct horse battery')
    expect(a).toMatch(/^\$argon2id\$/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('correct horse')
  })

  it('verify the right password and reject the wrong one', async () => {
    const hash = await hashPassword('s3cret-password')
    expect(await verifyPassword(hash, 's3cret-password')).toBe(true)
    expect(await verifyPassword(hash, 's3cret-passwor')).toBe(false)
    expect(await verifyPassword(hash, '')).toBe(false)
  })

  it('treat a malformed hash as a mismatch, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false)
    expect(await verifyPassword('', 'x')).toBe(false)
  })

  it('flag hashes made with weaker settings for an upgrade at next login', async () => {
    const weak = await argon2.hash('pw', {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    })
    expect(needsRehash(weak)).toBe(true)
    expect(needsRehash(await hashPassword('pw'))).toBe(false)
  })
})
