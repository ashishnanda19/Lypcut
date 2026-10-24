import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The token vault: how an Instagram access token is stored. Nothing else writes a token to the database, and only this
 * code can turn the stored form back into a token.
 *
 * A token is sealed with AES-256-GCM into a single string, `v1.<keyId>.<nonce>.<ciphertext+tag>` (base64url). The key id is in
 * the string so a token sealed with an older key still opens after the key is rotated; the key id and the owner's id are
 * also authenticated data, so changing the id in the string, or copying one person's sealed token onto another's row,
 * fails to open instead of opening quietly. A fresh random 96-bit nonce is used every time.
 *
 * Errors never contain the token, the key or the sealed string.
 */

const VERSION = 'v1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/

export interface VaultKey {
  id: string
  key: Buffer
}

export type VaultErrorCode = 'bad_key' | 'malformed' | 'unknown_key' | 'cannot_open' | 'empty'

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

/** `id:base64key`, where the key is 32 random bytes. Generate one with: openssl rand -base64 32 */
export function parseVaultKey(spec: string): VaultKey {
  const at = spec.indexOf(':')
  const id = at < 0 ? '' : spec.slice(0, at)
  if (!KEY_ID.test(id))
    throw new VaultError(
      'bad_key',
      'A token key must look like <id>:<base64 key>, with an id of 1-32 letters, digits, - or _.',
    )
  const key = Buffer.from(spec.slice(at + 1), 'base64')
  if (key.length !== KEY_BYTES)
    throw new VaultError(
      'bad_key',
      `A token key must be ${KEY_BYTES} bytes (openssl rand -base64 32).`,
    )
  return { id, key }
}

const aad = (keyId: string, owner: string) =>
  Buffer.from(`lypcut-ig-token|${VERSION}|${keyId}|${owner}`)
const b64 = (b: Buffer) => b.toString('base64url')

export class TokenVault {
  private readonly keys = new Map<string, Buffer>()

  /** `current` seals new tokens. `retired` keys only open what they sealed, until nothing is sealed with them any more. */
  constructor(
    private readonly current: VaultKey,
    retired: VaultKey[] = [],
  ) {
    for (const k of [current, ...retired]) {
      if (k.key.length !== KEY_BYTES)
        throw new VaultError('bad_key', 'A token key must be 32 bytes.')
      if (this.keys.has(k.id))
        throw new VaultError('bad_key', `Two token keys share the id ${k.id}.`)
      this.keys.set(k.id, k.key)
    }
  }

  get currentKeyId(): string {
    return this.current.id
  }

  /** Seals `token` for `owner` (the person it belongs to). The same owner must be given to open it. */
  seal(token: string, owner: string): { envelope: string; keyId: string } {
    if (!token) throw new VaultError('empty', 'There is no token to seal.')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.current.key, nonce, {
      authTagLength: TAG_BYTES,
    })
    cipher.setAAD(aad(this.current.id, owner))
    const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return {
      envelope: [VERSION, this.current.id, b64(nonce), b64(body)].join('.'),
      keyId: this.current.id,
    }
  }

  /** Opens a sealed token. Fails, with a code and no detail, for a wrong key, a changed envelope or a different owner. */
  open(envelope: string, owner: string): string {
    const { keyId, nonce, body } = this.parse(envelope)
    const key = this.keys.get(keyId)
    if (!key)
      throw new VaultError(
        'unknown_key',
        'This token was sealed with a key that is no longer configured.',
      )
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
      decipher.setAAD(aad(keyId, owner))
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
      return Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new VaultError('cannot_open', 'The stored token could not be opened.')
    }
  }

  /** Whether a sealed token should be sealed again, because it was sealed with a key that is not the current one. */
  needsRotation(envelope: string): boolean {
    return this.parse(envelope).keyId !== this.current.id
  }

  /** Seals the same token again with the current key. */
  rotate(envelope: string, owner: string): { envelope: string; keyId: string } {
    return this.seal(this.open(envelope, owner), owner)
  }

  private parse(envelope: string): { keyId: string; nonce: Buffer; body: Buffer } {
    const parts = envelope.split('.')
    if (parts.length !== 4 || parts[0] !== VERSION || !KEY_ID.test(parts[1]!))
      throw new VaultError('malformed', 'The stored token is not in a form the vault knows.')
    const nonce = Buffer.from(parts[2]!, 'base64url')
    const body = Buffer.from(parts[3]!, 'base64url')
    if (nonce.length !== NONCE_BYTES || body.length <= TAG_BYTES)
      throw new VaultError('malformed', 'The stored token is not in a form the vault knows.')
    return { keyId: parts[1]!, nonce, body }
  }
}

/**
 * Development and test run on this key so nothing needs setting up. It is public (it is in this file), so production refuses
 * it: config validation fails if NODE_ENV is production and TOKEN_ENCRYPTION_KEY is not set to a real key.
 */
export const DEVELOPMENT_KEY = 'dev:bG9jYWwtZGV2ZWxvcG1lbnQta2V5LW5vdC1zZWNyZXQ='

export function createVault(config: {
  TOKEN_ENCRYPTION_KEY?: string | undefined
  TOKEN_ENCRYPTION_OLD_KEYS: string[]
}): TokenVault {
  return new TokenVault(
    parseVaultKey(config.TOKEN_ENCRYPTION_KEY ?? DEVELOPMENT_KEY),
    config.TOKEN_ENCRYPTION_OLD_KEYS.map(parseVaultKey),
  )
}
