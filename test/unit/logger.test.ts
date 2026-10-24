import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { loggerOptions } from '../../src/lib/logger.js'

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  return { lines, log: pino(loggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'development' }), stream) }
}

describe('log redaction', () => {
  it('never writes credentials or personal data', () => {
    const { lines, log } = capture()
    log.info(
      {
        req: { headers: { authorization: 'Bearer SECRETJWT', cookie: 'lypcut_rt=SECRETREFRESH' } },
        res: { headers: { 'set-cookie': 'lypcut_at=SECRETACCESS' } },
        body: { email: 'asha@example.com', password: 'hunter2hunter2' },
        user: { email: 'asha@example.com' },
        session: {
          refreshToken: 'SECRETREFRESH2',
          accessToken: 'SECRETACCESS2',
          token: 'SECRETTOKEN',
        },
      },
      'login',
    )
    const out = lines.join('')
    for (const secret of [
      'SECRETJWT',
      'SECRETREFRESH',
      'SECRETACCESS',
      'asha@example.com',
      'hunter2hunter2',
      'SECRETTOKEN',
    ]) {
      expect(out, secret).not.toContain(secret)
    }
    expect(out).toContain('[redacted]')
  })

  it('writes structured JSON with level and service', () => {
    const { lines, log } = capture()
    log.warn({ reqId: 'r1' }, 'hello')
    const entry = JSON.parse(lines[0]!)
    expect(entry).toMatchObject({ level: 'warn', service: 'api', reqId: 'r1', msg: 'hello' })
  })
})
