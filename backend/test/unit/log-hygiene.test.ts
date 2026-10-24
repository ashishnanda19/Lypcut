import { Writable } from 'node:stream'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { loggerOptions, serializeRequest } from '../../src/lib/logger.js'

describe('logging a request', () => {
  it('keeps the method and the path, and drops the query: codes, states and what people searched for', () => {
    const lines: string[] = []
    const log = pino(
      loggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'development' }),
      new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }),
    )
    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/style/callback?code=AQD-secret-one-time-code&state=Zm9vYmFy&x=1',
          hostname: 'api.example.com',
          ip: '1.2.3.4',
        },
      },
      'incoming request',
    )
    const text = lines.join('')
    expect(text).toContain('/api/style/callback')
    for (const leak of ['AQD-secret', 'Zm9vYmFy', 'code=', 'state='])
      expect(text).not.toContain(leak)
    expect(JSON.parse(lines[0]!).req).toMatchObject({
      method: 'GET',
      url: '/api/style/callback',
      host: 'api.example.com',
    })
  })

  it('works for a search too, and for a request with no query', () => {
    expect(
      serializeRequest({ method: 'GET', url: '/api/projects/abc/search?q=my%20secret%20pitch' })
        .url,
    ).toBe('/api/projects/abc/search')
    expect(serializeRequest({ method: 'GET', url: '/api/me' }).url).toBe('/api/me')
    expect(serializeRequest({}).url).toBe('')
  })
})
