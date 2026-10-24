/**
 * Test infrastructure is the Docker Compose stack (postgres, redis, minio on their host ports)
 * with a separate database, Redis db and bucket, so tests never touch development data.
 */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://lypcut:lypcut@localhost:5433/lypcut_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1',
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
  S3_BUCKET: 'lypcut-test',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'lypcut',
  S3_SECRET_ACCESS_KEY: 'lypcut-local-secret',
  S3_FORCE_PATH_STYLE: 'true',
  CORS_ORIGINS: 'http://localhost:5173',
  AUTH_ACCESS_SECRET: 'test-secret-test-secret-test-secret-test-secret',
  // High enough that ordinary tests never trip it; the tests that exercise limits lower it.
  AUTH_RATE_LIMIT_MAX: '1000',
}
