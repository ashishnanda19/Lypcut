import argon2 from 'argon2'

/**
 * Passwords are hashed with argon2id, with the OWASP-recommended minimum cost
 * (19 MiB memory, 2 passes, 1 lane). The hash string carries its own salt and parameters, so
 * the cost can be raised later and old hashes still verify.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTIONS)

/** argon2.verify compares in constant time. A malformed hash counts as a mismatch, not a crash. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

/** True if the stored hash was made with weaker parameters than we use now, so it can be upgraded at login. */
export const needsRehash = (hash: string): boolean => argon2.needsRehash(hash, OPTIONS)
