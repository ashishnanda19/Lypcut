/**
 * One error format for the whole API: { error: { code, message, details? } }.
 * Services throw AppError; the error handler (app/plugins/errors.ts) turns it into that shape.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'VERSION_CONFLICT'
  | 'INVALID_OP'
  | 'STALE_PLAN'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'LIMIT_VIDEO_LENGTH'
  | 'LIMIT_MONTHLY_UPLOADS'
  | 'LIMIT_STYLE_REELS'
  | 'LIMIT_REEL_LENGTH'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_INCOMPLETE'
  | 'CHECKSUM_MISMATCH'
  | 'NOT_READY'
  | 'NOT_IMPLEMENTED'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const err = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(422, 'VALIDATION_ERROR', message, details),
  unauthenticated: (message = 'Please log in to continue.') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'That email or password is not right.'),
  forbidden: (message = 'You do not have access to that.') =>
    new AppError(403, 'FORBIDDEN', message),
  /** Also used for resources owned by someone else, so ids cannot be probed. */
  notFound: (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  tooLarge: (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  unsupported: (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA', message),
  limit: (
    code:
      'LIMIT_VIDEO_LENGTH' | 'LIMIT_MONTHLY_UPLOADS' | 'LIMIT_STYLE_REELS' | 'LIMIT_REEL_LENGTH',
    message: string,
    details?: Record<string, unknown>,
  ) => new AppError(403, code, message, details),
  notImplemented: (message: string) => new AppError(501, 'NOT_IMPLEMENTED', message),
  unavailable: (message: string) => new AppError(503, 'UNAVAILABLE', message),
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}
