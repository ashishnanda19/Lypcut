import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

/** SHA-256 (hex) of a stream, read in chunks: memory use stays flat however large the file is. */
export async function sha256Stream(stream: Readable): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
