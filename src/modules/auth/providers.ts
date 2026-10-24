import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { users } from '../../db/schema/index.js'
import { err } from '../../lib/errors.js'
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js'

type UserRow = typeof users.$inferSelect

/**
 * Anything that can turn some credentials into a user. Email and password is the only one today.
 * Google or Apple sign-in later is another provider plus a route: sessions, tokens and cookies
 * (AuthService) do not change.
 */
export interface IdentityProvider<Input> {
  readonly name: string
  authenticate(input: Input): Promise<UserRow>
}

export interface PasswordInput {
  email: string
  password: string
}

/** A real hash of a random password, verified against when the email is unknown, so timing does not reveal which emails exist. */
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`))

export class PasswordProvider implements IdentityProvider<PasswordInput> {
  readonly name = 'password'
  constructor(private readonly db: Db) {}

  async authenticate({ email, password }: PasswordInput): Promise<UserRow> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email))
    // Always run one verification, whether or not the account exists.
    const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password)
    if (!user || !user.passwordHash || !ok) throw err.invalidCredentials()

    if (needsRehash(user.passwordHash)) {
      await this.db
        .update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.id, user.id))
    }
    return user
  }
}
