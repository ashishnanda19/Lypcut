import { eq } from 'drizzle-orm'
import { loadConfigOrExit } from '../lib/bootstrap.js'
import { hashPassword } from '../lib/password.js'
import { createDatabase } from './client.js'
import { userPreferences, users } from './schema/index.js'

/**
 * Development seed: one demo account, ready to log in with. Safe to run repeatedly.
 * Refuses to run in production.
 */
const config = loadConfigOrExit()
if (config.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.')
  process.exit(1)
}

const EMAIL = 'demo@lypcut.dev'
const PASSWORD = process.env.SEED_PASSWORD ?? 'lypcut-demo-1'

const database = createDatabase(config)
const { db } = database

const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL))
if (existing.length) {
  console.log(`demo user already exists: ${EMAIL}`)
} else {
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, name: 'Demo Creator', passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id })
  await db.insert(userPreferences).values({
    userId: user!.id,
    language: 'hinglish',
    contentType: 'youtuber',
    onboardedAt: new Date(),
  })
  console.log(`created demo user: ${EMAIL} / ${PASSWORD}`)
}
await database.close()
