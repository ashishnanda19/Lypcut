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
