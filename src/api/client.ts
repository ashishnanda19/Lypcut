/** Thin typed fetch wrapper. The mock server (MSW) and a real backend answer the same routes. */

export class ApiError extends Error {
  status: number
  field?: string
  constructor(message: string, status: number, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Could not reach Lypcut. Check your connection and try again.', 0)
  }
  if (!res.ok) {
    let message = 'Something went wrong. Please try again.'
    let field: string | undefined
    try {
      const data = (await res.json()) as { message?: string; field?: string }
      if (data.message) message = data.message
      field = data.field
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(message, res.status, field)
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
