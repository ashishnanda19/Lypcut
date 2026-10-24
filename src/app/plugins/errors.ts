import type { FastifyError, FastifyInstance } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod'
import { AppError, type ErrorBody, type ErrorCode } from '../../lib/errors.js'

/** Every failure leaves the API as { error: { code, message, details? } }. */

function body(code: ErrorCode | string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } }
}

const FASTIFY_CODES: Record<string, [number, ErrorCode, string]> = {
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'PAYLOAD_TOO_LARGE', 'That request is too large.'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [
    415,
    'UNSUPPORTED_MEDIA',
    'Send JSON with Content-Type: application/json.',
  ],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'VALIDATION_ERROR', 'The request body is not valid JSON.'],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'VALIDATION_ERROR', 'The request body is empty.'],
}

export function registerErrorHandling(app: FastifyInstance): void {
  // Rate limited like any route, so scanning for URLs is not free.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    reply
      .status(404)
      .send(body('NOT_FOUND', `No route for ${req.method} ${req.url.split('?')[0]}.`))
  })

  app.setErrorHandler((error: FastifyError | Error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send(body(error.code, error.message, error.details))
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((v) => ({
        path: v.instancePath.split('/').filter(Boolean).join('.'),
        message: v.message ?? 'Invalid value.',
      }))
      const field = issues[0]?.path.split('.')[0]
      return reply.status(422).send(
        body('VALIDATION_ERROR', issues[0]?.message ?? 'The request is not valid.', {
          field: field || undefined,
          issues,
        }),
      )
    }

    if (isResponseSerializationError(error)) {
      req.log.error({ err: error }, 'response did not match its schema')
      return reply.status(500).send(body('INTERNAL_ERROR', 'Something went wrong on our side.'))
    }

    const statusCode =
      'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    const mapped =
      'code' in error && typeof error.code === 'string' ? FASTIFY_CODES[error.code] : undefined
    if (mapped) return reply.status(mapped[0]).send(body(mapped[1], mapped[2]))

    if (statusCode === 429) {
      return reply.status(429).send(body('RATE_LIMITED', 'Too many requests. Please slow down.'))
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(body('VALIDATION_ERROR', error.message))
    }

    req.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send(body('INTERNAL_ERROR', 'Something went wrong on our side.'))
  })
}
