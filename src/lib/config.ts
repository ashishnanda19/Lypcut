import os from 'node:os'
import { z } from 'zod'

/**
 * Twelve-factor config: everything comes from environment variables, validated once at startup.
 * The process refuses to start with a clear message if anything is missing or malformed.
 * Every variable is documented in .env.example.
 */

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
)

const url = z.url()
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), url.optional())
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional())

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Set when running behind a load balancer (ALB, CloudFront) so req.ip is the client's. */
    TRUST_PROXY: z.stringbool().default(false),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    TMP_DIR: z.string().default(os.tmpdir()),

    /** Browser origins allowed to call the API (the front end). Comma separated. */
    CORS_ORIGINS: csv.default(['http://localhost:5173']),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URL'),

    /** Leave S3_ENDPOINT unset for AWS S3. Set it (with S3_FORCE_PATH_STYLE) for MinIO. */
    S3_ENDPOINT: optionalUrl,
    /** Host the browser can reach, used only when signing URLs (differs from S3_ENDPOINT in Docker). */
    S3_PUBLIC_ENDPOINT: optionalUrl,
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    /** Leave both unset on AWS to use the task role. */
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
    /** When set (CloudFront later), download URLs are built from it instead of S3. */
    CDN_BASE_URL: optionalUrl,

    /** Signs access tokens (HS256). At least 32 characters; generate with: openssl rand -base64 48 */
    AUTH_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SEC: z.coerce
      .number()
      .int()
      .min(1)
      .default(15 * 60),
    REFRESH_TOKEN_TTL_SEC: z.coerce
      .number()
      .int()
      .min(60)
      .default(30 * 24 * 3600),
    /** A just-rotated refresh token reused within this window is a race between tabs, not theft. */
    REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).default(10),
    /** Defaults to true in production. Browsers only send Secure cookies over https. */
    COOKIE_SECURE: z.stringbool().optional(),
    COOKIE_DOMAIN: optionalString,
    /** Per-IP limit on signup, login and refresh, per window. Much stricter than the global limit. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    /** Failed logins per account before it is locked out for LOGIN_LOCK_SEC. */
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
    LOGIN_LOCK_SEC: z.coerce
      .number()
      .int()
      .min(1)
      .default(15 * 60),

    /** Largest file accepted, in bytes. Matches the front end's 8 GB limit. */
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(8 * 1024 ** 3),
    /** Multipart part size. S3 requires at least 5 MiB for every part but the last. */
    UPLOAD_PART_SIZE_MB: z.coerce.number().int().min(5).default(16),
    /** How long an unfinished upload can be resumed before it is aborted and cleaned up. */
    UPLOAD_TTL_HOURS: z.coerce.number().int().min(1).default(24),
    PRESIGN_GET_TTL_SEC: z.coerce.number().int().min(30).default(3600),
    PRESIGN_PUT_TTL_SEC: z.coerce.number().int().min(60).default(3600),
    FFPROBE_BIN: z.string().default('ffprobe'),
    FFMPEG_BIN: z.string().default('ffmpeg'),

    /** Speech recognition engine. whisper-local needs no account; the others are hosted services. */
    TRANSCRIPTION_PROVIDER: z
      .enum(['whisper-local', 'openai', 'assemblyai'])
      .default('whisper-local'),
    /** whisper.cpp command-line binary (whisper-cli) and its model file. */
    WHISPER_BIN: z.string().default('whisper-cli'),
    WHISPER_MODEL_PATH: z.string().default('./models/ggml-small.bin'),
    WHISPER_THREADS: z.coerce.number().int().min(1).default(4),
    /** Optional text that primes Whisper, for example a line of Hinglish to bias it towards Roman script. */
    WHISPER_PROMPT: optionalString,
    OPENAI_API_KEY: optionalString,
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
    OPENAI_TRANSCRIBE_MODEL: z.string().default('whisper-1'),
    ASSEMBLYAI_API_KEY: optionalString,
    ASSEMBLYAI_BASE_URL: z.string().default('https://api.assemblyai.com'),

    /** How many times a failing job is tried (with growing waits) before it is marked failed and kept as a dead letter. */
    JOB_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    /** First wait before a retry; each further retry waits twice as long. */
    JOB_BACKOFF_MS: z.coerce.number().int().min(0).default(2000),
    /** Processing jobs at once per worker. Video work is heavy: raise it only with CPU to spare. */
    PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    /** FFmpeg's scene-change score (0-1) above which a picture change counts as a cut. Lower finds more. */
    SCENE_THRESHOLD: z.coerce.number().min(0.05).max(0.95).default(0.3),
    /** Scenes shorter than this are folded into their neighbour; longer unbroken shots are split at this length. */
    MIN_SCENE_SEC: z.coerce.number().min(0.5).default(1.5),
    MAX_SCENE_SEC: z.coerce.number().min(5).default(60),

    /** How often the live job feed re-reads a watched, unfinished job, in case a Redis message was missed. */
    JOBS_WS_REFRESH_MS: z.coerce.number().int().min(50).default(3000),
    /** How often the live feed pings each client, and drops the ones that stopped answering. */
    JOBS_WS_PING_MS: z.coerce.number().int().min(100).default(30_000),

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      })
    }
    const needs = {
      openai: ['OPENAI_API_KEY', env.OPENAI_API_KEY],
      assemblyai: ['ASSEMBLYAI_API_KEY', env.ASSEMBLYAI_API_KEY],
    } as const
    const need = needs[env.TRANSCRIPTION_PROVIDER as keyof typeof needs]
    if (need && !need[1]) {
      ctx.addIssue({
        code: 'custom',
        path: [need[0]],
        message: `required when TRANSCRIPTION_PROVIDER=${env.TRANSCRIPTION_PROVIDER}`,
      })
    }
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'a wildcard origin is not allowed in production',
      })
    }
  })

export type Config = z.infer<typeof envSchema>

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (KEY=) means "not set", so defaults apply instead of failing validation.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== '' && v !== undefined),
  )
  const parsed = envSchema.safeParse(present)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    )
  }
  return parsed.data
}
