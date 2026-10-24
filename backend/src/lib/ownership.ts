import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { projects, uploads } from '../db/schema/index.js'
import { err } from './errors.js'
import { UUID_RE } from './ids.js'

/**
 * Every lookup of something a user owns goes through here. The owner is part of the query's WHERE
 * clause, so a row belonging to someone else is never even fetched, and the answer is "not found"
 * rather than "forbidden", so ids cannot be used to discover what exists.
 */
export async function requireProject(db: Db, userId: string, projectId: string) {
  if (!UUID_RE.test(projectId)) throw err.notFound('Project')
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
  if (!row) throw err.notFound('Project')
  return row
}

export async function requireUpload(db: Db, userId: string, uploadId: string) {
  if (!UUID_RE.test(uploadId)) throw err.notFound('Upload')
  const [row] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)))
  if (!row) throw err.notFound('Upload')
  return row
}
