import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Storage } from '../lib/storage.js'

/**
 * Scratch space for one job, under the temp directory only: no other disk is assumed, so the same code
 * runs on a laptop, in a container and on Fargate. It is always removed when the job ends, however it ends.
 */
export class WorkDir {
  private constructor(readonly dir: string) {}

  static create(tmpRoot: string, jobId: string): WorkDir {
    const dir = path.join(tmpRoot, 'lypcut', jobId)
    fs.mkdirSync(dir, { recursive: true })
    return new WorkDir(dir)
  }

  file(name: string): string {
    return path.join(this.dir, name)
  }

  exists(name: string, sizeBytes?: number): boolean {
    try {
      const stat = fs.statSync(this.file(name))
      return sizeBytes === undefined || stat.size === sizeBytes
    } catch {
      return false
    }
  }

  remove(name: string): void {
    fs.rmSync(this.file(name), { force: true })
  }

  destroy(): void {
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}

/**
 * Downloads an object to a file as a stream, hashing it on the way. Nothing is held in memory, so a
 * multi-gigabyte video costs no more RAM than a small one. Returns the SHA-256 of what was written.
 */
export async function downloadTo(
  storage: Storage,
  key: string,
  file: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256')
  const source = await storage.getStream(key)
  source.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(source, fs.createWriteStream(file), { signal })
  return hash.digest('hex')
}

/** Uploads a local file as a stream (a multipart upload under the hood for large files). */
export async function uploadFrom(
  storage: Storage,
  key: string,
  file: string,
  contentType: string,
): Promise<number> {
  await storage.putStream(key, fs.createReadStream(file), contentType)
  return fs.statSync(file).size
}
