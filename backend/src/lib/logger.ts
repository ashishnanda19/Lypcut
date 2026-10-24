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

/**
 * A request as it is logged: the method and the path, never the query string. Queries hold what people typed in a search, and on the
 * Instagram callback the one-time code and the sign-in state, none of which may reach a log.
 */
export function serializeRequest(req: {
  method?: string
  url?: string
  hostname?: string
  ip?: string
  socket?: { remotePort?: number }
}) {
  return {
    method: req.method,
    url: (req.url ?? '').split('?')[0],
    host: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}

export function loggerOptions(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, name = 'api') {
  return {
    level: config.NODE_ENV === 'test' && config.LOG_LEVEL === 'info' ? 'silent' : config.LOG_LEVEL,
    base: { service: name },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: { req: serializeRequest },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
  }
}
