import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { uploads } from '../db/schema/index.js'

export interface ActiveUpload {
  key: string
  uploadId: string
}

/**
 * Multipart uploads still in flight. Their parts are not objects yet, so deleting a prefix does not
 * remove them and storage would keep billing for them. They are recorded in the cleanup job's
 * payload and aborted by the worker.
 */
export async function activeUploads(
  db: Db,
  scope: { userId: string; styleOnly?: boolean } | { projectId: string },
): Promise<ActiveUpload[]> {
  const where: SQL | undefined = and(
    inArray(uploads.status, ['initiated', 'uploading', 'completing']),
    'userId' in scope ? eq(uploads.userId, scope.userId) : eq(uploads.projectId, scope.projectId),
    // A style Reel's upload has no project; leaving a project's own uploads alone matters when only style data goes.
    'userId' in scope && scope.styleOnly ? isNull(uploads.projectId) : undefined,
  )
  const rows = await db
    .select({ key: uploads.storageKey, uploadId: uploads.s3UploadId })
    .from(uploads)
    .where(where)
  return rows
}
