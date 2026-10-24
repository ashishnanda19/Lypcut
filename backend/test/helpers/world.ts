import { eq } from 'drizzle-orm'
import { users } from '../../src/db/schema/index.js'
import type { TestApp } from './app.js'
import { TestClient } from './client.js'

export const ORIGIN = 'http://localhost:5173'
export const PASSWORD = 'correct-horse-battery'

let n = 0

export interface Person {
  c: TestClient
  id: string
  email: string
}

/** Signs a new user up and returns a logged-in browser for them. */
export async function signup(t: TestApp, plan?: 'free' | 'creator' | 'studio'): Promise<Person> {
  const email = `person${++n}-${Date.now().toString(36)}@example.com`
  const c = new TestClient(t.app, { headers: { origin: ORIGIN } })
  const res = await c.post('/api/auth/signup', { email, password: PASSWORD })
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`)
  const id = res.body.user.id as string
  if (plan) await t.deps.database.db.update(users).set({ plan }).where(eq(users.id, id))
  return { c, id, email }
}
