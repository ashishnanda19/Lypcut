import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ClientModule from './client'

type Client = typeof ClientModule

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const expired = () =>
  json(401, { error: { code: 'UNAUTHENTICATED', message: 'Please log in to continue.' } })

async function load(mode: 'real' | 'mock'): Promise<Client> {
  vi.resetModules()
  vi.stubEnv('VITE_API_MODE', mode)
  return import('./client')
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const urls = () => fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${c[0]}`)

describe('reading errors', () => {
  it("reads the backend's { error: { code, message, details } }", async () => {
    const { parseError } = await load('real')
    const e = parseError(422, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Enter a valid email.',
        details: { field: 'email' },
      },
    })
    expect(e).toMatchObject({
      status: 422,
      message: 'Enter a valid email.',
      field: 'email',
      code: 'VALIDATION_ERROR',
    })
  })

  it("reads the mock's { message, field }", async () => {
    const { parseError } = await load('mock')
    expect(parseError(422, { message: 'Too short.', field: 'password' })).toMatchObject({
      message: 'Too short.',
      field: 'password',
    })
  })

  it('keeps the details a screen needs, such as the plan limit', async () => {
    const { parseError } = await load('real')
    const e = parseError(403, {
      error: { code: 'LIMIT_VIDEO_LENGTH', message: 'Too long.', details: { maxSeconds: 600 } },
    })
    expect(e.code).toBe('LIMIT_VIDEO_LENGTH')
    expect(e.details).toEqual({ maxSeconds: 600 })
  })

  it('falls back to a plain sentence when the body is not what we expect', async () => {
    const { parseError } = await load('real')
    for (const body of [undefined, null, 'oops', 42, {}, { error: 'x' }, { error: {} }]) {
      expect(parseError(500, body).message).toBe('Something went wrong. Please try again.')
    }
  })
})

describe('making calls', () => {
  it('sends the session cookie and only sets a content type when there is a body', async () => {
    const { api } = await load('real')
    fetchMock.mockImplementation(async () => json(200, { ok: true }))
    await api.get('/projects')
    await api.post('/projects', { fileName: 'a.mp4' })
    const [get, post] = fetchMock.mock.calls.map((c) => c[1] as RequestInit)
    expect(get!.credentials).toBe('same-origin')
    expect(get!.headers).toEqual({})
    expect(post!.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(post!.body).toBe('{"fileName":"a.mp4"}')
  })

  it('turns a network failure into a readable error', async () => {
    const { api } = await load('real')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(api.get('/projects')).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('Could not reach'),
    })
  })

  it('throws the server error with its status', async () => {
    const { api } = await load('real')
    fetchMock.mockResolvedValue(
      json(404, { error: { code: 'NOT_FOUND', message: 'Project not found.' } }),
    )
    await expect(api.get('/projects/x')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Project not found.',
    })
  })

  it('gives a download its suggested name, including a Hindi one', async () => {
    const { api } = await load('real')
    fetchMock.mockResolvedValue(
      new Response('{}', {
        headers: {
          'content-disposition': `attachment; filename="project.otio"; filename*=UTF-8''%E0%A4%AB%E0%A4%82%E0%A4%A1%E0%A4%BF%E0%A4%82%E0%A4%97.otio`,
        },
      }),
    )
    const d = await api.download('/projects/p/export/otio')
    expect(d.filename).toBe('फंडिंग.otio')
    expect(await d.blob.text()).toBe('{}')
  })
})

describe('an expired session', () => {
  it('refreshes once and repeats the call', async () => {
    const { api } = await load('real')
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(json(200, { user: {} })) // refresh
      .mockResolvedValueOnce(json(200, [{ id: 'p1' }]))
    expect(await api.get('/projects')).toEqual([{ id: 'p1' }])
    expect(urls()).toEqual(['GET /api/projects', 'POST /api/auth/refresh', 'GET /api/projects'])
  })

  it('shares one refresh between calls that expire together', async () => {
    const { api } = await load('real')
    let refreshes = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/auth/refresh') {
        refreshes++
        await new Promise((r) => setTimeout(r, 20))
        return json(200, {})
      }
      // Every call fails until the refresh has happened.
      return refreshes ? json(200, { ok: url }) : expired()
    })
    const all = await Promise.all([api.get('/projects'), api.get('/me'), api.get('/jobs/j')])
    expect(all).toHaveLength(3)
    expect(refreshes).toBe(1)
  })

  it('tells the app the session is over when the refresh is refused', async () => {
    const { api, setSessionExpiredHandler } = await load('real')
    const gone = vi.fn()
    setSessionExpiredHandler(gone)
    fetchMock.mockImplementation(async () => expired())
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401 })
    expect(gone).toHaveBeenCalledOnce()
  })

  it('does not loop: a call is repeated once, not forever', async () => {
    const { api } = await load('real')
    fetchMock.mockImplementation(async () => expired())
    await expect(api.get('/projects')).rejects.toBeInstanceOf(Error)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('never tries to refresh on a wrong password, or on the refresh itself', async () => {
    const { api } = await load('real')
    fetchMock.mockResolvedValue(
      json(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'That email or password is not right.' },
      }),
    )
    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
    expect(urls()).toEqual(['POST /api/auth/login'])
  })

  it('leaves the mock alone: there is no refresh endpoint there', async () => {
    const { api } = await load('mock')
    fetchMock.mockResolvedValue(expired())
    await expect(api.get('/projects')).rejects.toMatchObject({ status: 401 })
    expect(urls()).toEqual(['GET /api/projects'])
  })
})
