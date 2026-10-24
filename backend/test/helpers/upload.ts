import fs from 'node:fs'
import { expect } from 'vitest'
import type { Res, TestClient } from './client.js'

export interface UploadInfo {
  id: string
  projectId: string
  sizeBytes: number
  partSize: number
  totalParts: number
}

/** Creates a project and starts an upload for a file, as the front end will. */
export async function startUpload(
  c: TestClient,
  file: string,
  opts: { fileName?: string; durationSec?: number; contentType?: string; projectId?: string } = {},
): Promise<{ projectId: string; upload: UploadInfo; res: Res }> {
  const fileName = opts.fileName ?? 'My Podcast.mp4'
  let projectId = opts.projectId
  if (!projectId) {
    const created = await c.post('/api/projects', { fileName, durationSec: opts.durationSec })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    projectId = created.body.project.id as string
  }
  const res = await c.post('/api/uploads', {
    projectId,
    fileName,
    contentType: opts.contentType ?? 'video/mp4',
    sizeBytes: fs.statSync(file).size,
    durationSec: opts.durationSec,
  })
  return { projectId, upload: res.body.upload as UploadInfo, res }
}

/** Sends the given parts (all of them by default) straight to storage through presigned URLs. */
export async function putParts(
  c: TestClient,
  upload: UploadInfo,
  file: string,
  partNumbers?: number[],
  mutate?: (part: number, data: Buffer) => Buffer,
): Promise<void> {
  const numbers = partNumbers ?? Array.from({ length: upload.totalParts }, (_, i) => i + 1)
  const presigned = await c.post(`/api/uploads/${upload.id}/parts`, { partNumbers: numbers })
  expect(presigned.status, JSON.stringify(presigned.body)).toBe(200)
  const fd = fs.openSync(file, 'r')
  try {
    for (const { partNumber, url } of presigned.body.urls as Array<{
      partNumber: number
      url: string
    }>) {
      const start = (partNumber - 1) * upload.partSize
      const length = Math.min(upload.partSize, upload.sizeBytes - start)
      let data: Buffer = Buffer.alloc(length)
      fs.readSync(fd, data, 0, length, start)
      if (mutate) data = mutate(partNumber, data)
      const put = await fetch(url, { method: 'PUT', body: data })
      expect(put.ok, `part ${partNumber}: ${put.status}`).toBe(true)
    }
  } finally {
    fs.closeSync(fd)
  }
}

export async function fullUpload(
  c: TestClient,
  file: string,
  opts: Parameters<typeof startUpload>[2] & { checksum?: string } = {},
) {
  const { projectId, upload, res } = await startUpload(c, file, opts)
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
  await putParts(c, upload, file)
  const done = await c.post(
    `/api/uploads/${upload.id}/complete`,
    opts.checksum ? { checksum: opts.checksum } : {},
  )
  return { projectId, upload, done }
}

/** Starts an upload for a style Reel: no project, `purpose: 'style_reel'`. */
export async function startStyleUpload(
  c: TestClient,
  file: string,
  opts: { fileName?: string; durationSec?: number; contentType?: string } = {},
): Promise<{ upload: UploadInfo; res: Res }> {
  const res = await c.post('/api/uploads', {
    purpose: 'style_reel',
    fileName: opts.fileName ?? 'reel.mp4',
    contentType: opts.contentType ?? 'video/mp4',
    sizeBytes: fs.statSync(file).size,
    durationSec: opts.durationSec,
  })
  return { upload: res.body.upload as UploadInfo, res }
}

/** Uploads a style Reel all the way through and returns what finishing it said. */
export async function fullStyleUpload(
  c: TestClient,
  file: string,
  opts: Parameters<typeof startStyleUpload>[2] & { checksum?: string } = {},
) {
  const { upload, res } = await startStyleUpload(c, file, opts)
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
  await putParts(c, upload, file)
  const done = await c.post(
    `/api/uploads/${upload.id}/complete`,
    opts.checksum ? { checksum: opts.checksum } : {},
  )
  return { upload, done }
}
