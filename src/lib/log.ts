import type { BaseLogger } from 'pino'

/** The few logging methods services use. Both Fastify's request logger and the worker's pino logger fit. */
export type Log = Pick<BaseLogger, 'debug' | 'info' | 'warn' | 'error'>
