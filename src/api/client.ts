/**
 * Thin typed fetch wrapper. The mock server (MSW) and the real backend answer the same routes.
 *
 * Against the real backend the session lives in httpOnly cookies, so every call is made with them. A 401 on an ordinary
 * call means the short access token ran out: the session is refreshed once (however many calls hit it together) and the
 * call is repeated. If the refresh itself is refused, the session is over and the app is told.
 */
import { isReal } from '@/lib/runtime'

export class ApiError extends Error {
  status: number
  field?: string
  /** The server's machine-readable code, for example LIMIT_VIDEO_LENGTH. Absent for the mock and for network failures. */
  code?: string
  details?: Record<string, unknown>
  constructor(
    message: string,
    status: number,
    field?: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
    this.code = code
    this.details = details
  }
}

const GENERIC = 'Something went wrong. Please try again.'

/**
 * Reads an error response. The backend sends { error: { code, message, details } } and names the field a validation
 * error is about in details.field; the mock sends { message, field }. Both give the same ApiError.
 */
export function parseError(status: number, data: unknown): ApiError {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const e = (d.error && typeof d.error === 'object' ? d.error : d) as Record<string, unknown>
  const message = typeof e.message === 'string' && e.message ? e.message : GENERIC
  const details =
    e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : undefined
  const field =
    typeof e.field === 'string'
      ? e.field
      : typeof details?.field === 'string'
        ? details.field
        : undefined
  const code = typeof e.code === 'string' ? e.code : undefined
  return new ApiError(message, status, field, code, details)
}

/** Paths whose 401 means "wrong credentials" or "no session", not "your token ran out". */
const NO_REFRESH = /^\/auth\/(login|signup|refresh|logout|google)$/

let onSessionExpired: (() => void) | null = null
/** The auth store registers here, so the client does not have to import it. */
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
}

let refreshing: Promise<boolean> | null = null
/** One refresh at a time: the backend rotates the refresh token, so two at once would fight. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      return res.ok
    } catch {
      return false
    } finally {
      // Let the next expiry start a fresh refresh once this one has settled.
      setTimeout(() => (refreshing = null), 0)
    }
  })()
  return refreshing
}

async function send(method: string, path: string, body?: unknown, accept?: string) {
  try {
    return await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accept ? { Accept: accept } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Could not reach Lypcut. Check your connection and try again.', 0)
  }
}

async function failure(res: Response): Promise<ApiError> {
  let data: unknown
  try {
    data = await res.json()
  } catch {
    /* keep the generic message */
  }
  return parseError(res.status, data)
}

/** Runs a call, refreshing the session once if the access token has expired. */
async function call(method: string, path: string, body?: unknown, accept?: string) {
  let res = await send(method, path, body, accept)
  if (res.status === 401 && isReal && !NO_REFRESH.test(path)) {
    // If the refresh is refused because another tab just did it, that tab's new cookies are already here: try once more.
    await refreshSession()
    res = await send(method, path, body, accept)
    if (res.status === 401) onSessionExpired?.()
  }
  if (!res.ok) throw await failure(res)
  return res
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body)
  return (await res.json()) as T
}

export interface Download {
  blob: Blob
  /** The name the server suggested, if it did. */
  filename?: string
}

function suggestedName(header: string | null): string | undefined {
  if (!header) return undefined
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      /* fall through to the plain name */
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1]
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** A file download, for example the OpenTimelineIO export. */
  download: async (path: string): Promise<Download> => {
    const res = await call('GET', path)
    return {
      blob: await res.blob(),
      filename: suggestedName(res.headers.get('content-disposition')),
    }
  },
}
