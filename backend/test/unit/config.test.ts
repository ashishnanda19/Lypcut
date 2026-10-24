import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/lib/config.js'
import { TEST_ENV } from '../helpers/env.js'

const base = { ...TEST_ENV }
const REAL_TOKEN_KEY = 'k1:' + Buffer.alloc(32, 7).toString('base64')

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const c = loadConfig(base)
    expect(c.PORT).toBe(4000)
    expect(c.TRUST_PROXY).toBe(false)
    expect(c.CORS_ORIGINS).toEqual(['http://localhost:5173'])
    expect(c.S3_FORCE_PATH_STYLE).toBe(true)
    expect(c.S3_PUBLIC_ENDPOINT).toBeUndefined()
  })

  it('coerces numbers and booleans and splits comma separated origins', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      TRUST_PROXY: 'true',
      CORS_ORIGINS: 'https://a.example, https://b.example',
    })
    expect(c.PORT).toBe(8080)
    expect(c.TRUST_PROXY).toBe(true)
    expect(c.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example'])
  })

  it('treats an empty value as unset so the default applies', () => {
    const c = loadConfig({ ...base, TMP_DIR: '', S3_ENDPOINT: '', CDN_BASE_URL: '' })
    expect(c.TMP_DIR.length).toBeGreaterThan(0)
    expect(c.S3_ENDPOINT).toBeUndefined()
    expect(c.CDN_BASE_URL).toBeUndefined()
  })

  it('refuses to start, naming every problem', () => {
    let error: unknown
    try {
      loadConfig({ NODE_ENV: 'development', PORT: 'abc', REDIS_URL: 'http://nope' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as ConfigError).message
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
    expect(message).toContain('PORT')
    expect(message).toContain('S3_BUCKET')
  })

  it('requires both storage credentials or neither', () => {
    expect(() => loadConfig({ ...base, S3_SECRET_ACCESS_KEY: '' })).toThrow(/set together/)
    const noCreds = { ...base, S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' }
    expect(() => loadConfig(noCreds)).not.toThrow()
  })

  it('rejects the development example secret in production only', () => {
    const example = { ...base, AUTH_ACCESS_SECRET: 'local-development-secret-change-me-0123456789' }
    expect(() => loadConfig({ ...example, NODE_ENV: 'production' })).toThrow(/development example/)
    expect(() => loadConfig({ ...example, NODE_ENV: 'development' })).not.toThrow()
    const real = {
      ...base,
      AUTH_ACCESS_SECRET: 'q7Zk2mV9xR4tLw8Hn3Yb6Pd1Gf5Sa0Jc',
      TOKEN_ENCRYPTION_KEY: REAL_TOKEN_KEY,
    }
    expect(() => loadConfig({ ...real, NODE_ENV: 'production' })).not.toThrow()
  })

  it('rejects a wildcard CORS origin in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /wildcard/,
    )
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', CORS_ORIGINS: '*' })).not.toThrow()
  })

  describe('the Instagram token key', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      AUTH_ACCESS_SECRET: 'q7Zk2mV9xR4tLw8Hn3Yb6Pd1Gf5Sa0Jc',
    }

    it('is optional outside production, where a public development key is used', () => {
      expect(loadConfig(base).TOKEN_ENCRYPTION_KEY).toBeUndefined()
      expect(loadConfig(base).TOKEN_ENCRYPTION_OLD_KEYS).toEqual([])
    })

    it('is required in production', () => {
      expect(() => loadConfig(prod)).toThrow(/TOKEN_ENCRYPTION_KEY/)
      expect(() => loadConfig({ ...prod, TOKEN_ENCRYPTION_KEY: REAL_TOKEN_KEY })).not.toThrow()
    })

    it('must be an id and 32 bytes, in the current key and the old ones, and ids must differ', () => {
      expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'not-a-key' })).toThrow(
        /TOKEN_ENCRYPTION_KEY/,
      )
      expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'k1:c2hvcnQ=' })).toThrow(/32 bytes/)
      expect(() =>
        loadConfig({
          ...base,
          TOKEN_ENCRYPTION_KEY: REAL_TOKEN_KEY,
          TOKEN_ENCRYPTION_OLD_KEYS: 'junk',
        }),
      ).toThrow(/TOKEN_ENCRYPTION_OLD_KEYS/)
      expect(() =>
        loadConfig({
          ...base,
          TOKEN_ENCRYPTION_KEY: REAL_TOKEN_KEY,
          TOKEN_ENCRYPTION_OLD_KEYS: REAL_TOKEN_KEY,
        }),
      ).toThrow(/different/)
      const old = 'k0:' + Buffer.alloc(32, 9).toString('base64')
      expect(
        loadConfig({
          ...base,
          TOKEN_ENCRYPTION_KEY: REAL_TOKEN_KEY,
          TOKEN_ENCRYPTION_OLD_KEYS: old,
        }).TOKEN_ENCRYPTION_OLD_KEYS,
      ).toEqual([old])
    })
  })
})
