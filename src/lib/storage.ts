import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Upload } from '@aws-sdk/lib-storage'
import type { Config } from './config.js'

type StorageConfig = Pick<
  Config,
  | 'S3_ENDPOINT'
  | 'S3_PUBLIC_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'CDN_BASE_URL'
>

export interface PartInfo {
  partNumber: number
  size: number
  etag: string
}

function makeClient(cfg: StorageConfig, endpoint: string | undefined) {
  return new S3Client({
    region: cfg.S3_REGION,
    endpoint,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    credentials:
      cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
        : undefined,
    // Keeps optional checksum headers off presigned part URLs; MinIO and S3 both accept this.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/**
 * Object storage behind one small interface. The same code talks to MinIO locally and to AWS S3
 * in production; only environment variables differ. Video bytes never pass through the API:
 * clients upload and download with presigned URLs.
 */
export class Storage {
  readonly bucket: string
  /** Server-side calls (inside Docker this is the internal MinIO address). */
  private readonly s3: S3Client
  /** Used only to sign URLs the browser will call (the public MinIO address, or S3). */
  private readonly signer: S3Client

  constructor(private readonly cfg: StorageConfig) {
    this.bucket = cfg.S3_BUCKET
    this.s3 = makeClient(cfg, cfg.S3_ENDPOINT)
    this.signer = cfg.S3_PUBLIC_ENDPOINT ? makeClient(cfg, cfg.S3_PUBLIC_ENDPOINT) : this.s3
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }

  /** Dev and test only: production buckets are created by infrastructure. */
  async ensureBucket(): Promise<void> {
    try {
      await this.ping()
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }))
    }
  }

  async head(key: string): Promise<{ size: number; etag?: string; contentType?: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: r.ContentLength ?? 0, etag: r.ETag, contentType: r.ContentType }
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
  }

  async putObject(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    )
  }

  /** Streams a file or any readable into storage without buffering it (multipart under the hood). */
  async putStream(key: string, body: Readable, contentType?: string): Promise<void> {
    await new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    }).done()
  }

  async getStream(key: string, range?: string): Promise<Readable> {
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
    )
    return r.Body as Readable
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  /** Deletes everything under a prefix, 1000 objects at a time. Returns how many went. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0
    let token: string | undefined
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
      if (keys.length) {
        await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        )
        deleted += keys.length
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return deleted
  }

  /**
   * A short-lived download URL scoped to one object. With CDN_BASE_URL set the URL points at the
   * CDN instead (CloudFront signing slots in here later).
   */
  async presignGet(
    key: string,
    opts: { ttlSec: number; filename?: string; contentType?: string },
  ): Promise<string> {
    if (this.cfg.CDN_BASE_URL) return `${this.cfg.CDN_BASE_URL.replace(/\/$/, '')}/${key}`
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.filename
          ? `attachment; filename="${opts.filename.replace(/["\\\r\n]/g, '_')}"`
          : undefined,
      }),
      { expiresIn: opts.ttlSec },
    )
  }

  /**
   * A download URL for the server's own use (ffprobe reading just a file's header). Signed against the
   * internal endpoint, so it works from inside Docker where the public one does not.
   */
  presignInternalGet(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSec,
    })
  }

  /* ----------------------------- multipart ---------------------------- */

  async createMultipart(key: string, contentType: string): Promise<string> {
    const r = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    )
    if (!r.UploadId) throw new Error('Storage did not return an upload id')
    return r.UploadId
  }

  presignPart(key: string, uploadId: string, partNumber: number, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSec },
    )
  }

  async listParts(key: string, uploadId: string): Promise<PartInfo[]> {
    const parts: PartInfo[] = []
    let marker: string | undefined
    for (;;) {
      const r = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      )
      for (const p of r.Parts ?? []) {
        if (p.PartNumber && p.ETag)
          parts.push({ partNumber: p.PartNumber, size: p.Size ?? 0, etag: p.ETag })
      }
      if (!r.IsTruncated) break
      marker = r.NextPartNumberMarker
    }
    return parts
  }

  async completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    )
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      )
    } catch (e) {
      if (!isNoSuchUpload(e)) throw e
    }
  }

  destroy(): void {
    this.s3.destroy()
    if (this.signer !== this.s3) this.signer.destroy()
  }
}

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e
    ? String((e as { name: unknown }).name)
    : ''
}
export const isNotFound = (e: unknown) => ['NotFound', 'NoSuchKey'].includes(errName(e))
export const isNoSuchUpload = (e: unknown) => errName(e) === 'NoSuchUpload'
