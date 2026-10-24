import { eq } from 'drizzle-orm'
import type { Log } from '../../lib/log.js'
import type { AppDeps } from '../../app/types.js'
import { jobs, userPreferences, users } from '../../db/schema/index.js'
import { err } from '../../lib/errors.js'
import { activeUploads } from '../../lib/deletion.js'
import { enqueueJob } from '../../queue/enqueue.js'
import type { z } from 'zod'
import type { UserDto, updateMeBody } from './schema.js'

type Db = AppDeps['database']['db']

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'creator'
  const word = local.replace(/[._-]+/g, ' ').trim()
  return word.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Creator'
}

export function toUserDto(
  user: typeof users.$inferSelect,
  prefs: typeof userPreferences.$inferSelect | undefined,
): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    language: prefs?.language ?? 'hinglish',
    contentType: prefs?.contentType ?? null,
    onboarded: Boolean(prefs?.onboardedAt),
    plan: user.plan,
  }
}

export async function loadUserDto(db: Db, userId: string): Promise<UserDto | null> {
  const [row] = await db
    .select({ user: users, prefs: userPreferences })
    .from(users)
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(eq(users.id, userId))
  return row ? toUserDto(row.user, row.prefs ?? undefined) : null
}

export class AccountService {
  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {}

  private get db() {
    return this.deps.database.db
  }

  async get(userId: string): Promise<UserDto> {
    const dto = await loadUserDto(this.db, userId)
    if (!dto) throw err.unauthenticated()
    return dto
  }

  async update(userId: string, patch: z.infer<typeof updateMeBody>): Promise<UserDto> {
    await this.db.transaction(async (tx) => {
      if (patch.name !== undefined)
        await tx.update(users).set({ name: patch.name }).where(eq(users.id, userId))

      const prefs: Partial<typeof userPreferences.$inferInsert> = {}
      if (patch.language !== undefined) prefs.language = patch.language
      if (patch.contentType !== undefined) prefs.contentType = patch.contentType
      if (patch.onboarded) prefs.onboardedAt = new Date()
      if (Object.keys(prefs).length) {
        // An account made before preferences existed still works: create the row if it is missing.
        await tx
          .insert(userPreferences)
          .values({ userId, ...prefs })
          .onConflictDoUpdate({ target: userPreferences.userId, set: prefs })
      }
    })
    return this.get(userId)
  }

  /**
   * Deletes the account. Every row that belongs to the user goes in one transaction (the database
   * cascades from `users`), and a cleanup job removes their files from storage. The job row is written
   * in the same transaction, so deleting the data and promising to delete the files cannot come apart.
   */
  async delete(userId: string): Promise<void> {
    const prefix = `users/${userId}/`
    const uploads = await activeUploads(this.db, { userId })
    const row = await this.db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobs)
        // userId stays null: the user is about to stop existing.
        .values({ type: 'delete_account', payload: { prefix, uploads } })
        .returning({ id: jobs.id, type: jobs.type })
      await tx.delete(users).where(eq(users.id, userId))
      return job!
    })
    // If this enqueue is lost, the worker's reconcile sweep picks the row up.
    await enqueueJob(this.deps.queues, row).catch((e) =>
      this.log.error(
        { err: e, jobId: row.id },
        'could not enqueue account cleanup; the sweep will retry',
      ),
    )
  }
}
