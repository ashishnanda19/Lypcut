import type { Config } from './config.js'

/**
 * Structured JSON logs (pino, via Fastify). Credentials and personal data are redacted at the
 * logger, so nothing downstream can leak them by accident.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.email',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
]

export function loggerOptions(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, name = 'api') {
  return {
    level: config.NODE_ENV === 'test' && config.LOG_LEVEL === 'info' ? 'silent' : config.LOG_LEVEL,
    base: { service: name },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
  }
}
