import type { FastifyInstance, InjectOptions } from 'fastify'

interface StoredCookie {
  value: string
  path: string
}

export interface Res {
  status: number
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: bodies are asserted on loosely
  headers: Record<string, string | string[] | number | undefined>
  setCookies: string[]
}

/**
 * A tiny browser: keeps cookies between requests (honouring Path, Max-Age and clearing), so tests
 * exercise the real cookie flow rather than hand-copying tokens around.
 */
export class TestClient {
  jar = new Map<string, StoredCookie>()
  constructor(
    private readonly app: FastifyInstance,
    private readonly defaults: { headers?: Record<string, string> } = {},
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name)?.value
  }

  async request(
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const path = url.split('?')[0]!
    const cookie = [...this.jar.entries()]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ')
    const res = await this.app.inject({
      method,
      url,
      payload: payload as InjectOptions['payload'],
      headers: { ...this.defaults.headers, ...(cookie ? { cookie } : {}), ...headers },
    })
    const raw = res.headers['set-cookie']
    const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    for (const c of res.cookies) {
      const gone =
        c.value === '' || (c.expires && c.expires.getTime() < Date.now()) || c.maxAge === 0
      if (gone) this.jar.delete(c.name)
      else this.jar.set(c.name, { value: c.value, path: c.path ?? '/' })
    }
    let body: unknown
    try {
      body = res.json()
    } catch {
      body = res.body
    }
    return { status: res.statusCode, body, headers: res.headers, setCookies }
  }

  get = (url: string, headers?: Record<string, string>) =>
    this.request('GET', url, undefined, headers)
  post = (url: string, payload?: unknown, headers?: Record<string, string>) =>
    this.request('POST', url, payload, headers)
  patch = (url: string, payload: unknown, headers?: Record<string, string>) =>
    this.request('PATCH', url, payload, headers)
  del = (url: string, headers?: Record<string, string>) =>
    this.request('DELETE', url, undefined, headers)
}
