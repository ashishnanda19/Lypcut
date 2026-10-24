import { WebSocket } from 'ws'
import type { TestApp } from './app.js'
import { ORIGIN } from './world.js'
import type { TestClient } from './client.js'

/** Starts the app on a real port, so WebSocket clients can connect. Returns the ws:// URL of the job feed. */
export async function listen(t: TestApp): Promise<string> {
  await t.app.listen({ host: '127.0.0.1', port: 0 })
  const addr = t.app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  return `ws://127.0.0.1:${addr.port}/api/jobs/ws`
}

/** The login cookies of a browser, as a Cookie header a WebSocket handshake can carry. */
export const cookieHeader = (c: TestClient): string =>
  [...c.jar.entries()]
    // Cookies scoped to /api/auth (the refresh token) are not sent to the job feed, exactly as a browser would not.
    .filter(([, v]) => '/api/jobs/ws'.startsWith(v.path))
    .map(([k, v]) => `${k}=${v.value}`)
    .join('; ')

export type Msg = { type: string; [k: string]: unknown }

/** A WebSocket client that remembers everything it was sent, and can wait for a particular message. */
export class Feed {
  readonly messages: Msg[] = []
  private waiters: Array<{ test: (m: Msg) => boolean; resolve: (m: Msg) => void }> = []
  closed: { code: number } | null = null

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Msg
      this.messages.push(msg)
      this.waiters = this.waiters.filter((w) => {
        if (!w.test(msg)) return true
        w.resolve(msg)
        return false
      })
    })
    socket.on('close', (code) => {
      this.closed = { code }
    })
  }

  /** Connects, or resolves with the HTTP status if the handshake is refused. */
  static async connect(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<Feed | { refused: number }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers })
      socket.once('open', () => resolve(new Feed(socket)))
      socket.once('unexpected-response', (_req, res) => resolve({ refused: res.statusCode ?? 0 }))
      socket.once('error', (e) => {
        if (!/Unexpected server response/.test(String(e))) reject(e)
      })
    })
  }

  static async open(url: string, c: TestClient, origin = ORIGIN): Promise<Feed> {
    const feed = await Feed.connect(url, { cookie: cookieHeader(c), origin })
    if ('refused' in feed) throw new Error(`refused: ${feed.refused}`)
    return feed
  }

  send(msg: unknown) {
    this.socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }

  subscribe(jobId: string) {
    this.send({ type: 'subscribe', jobId })
  }

  /** The next message (new or already received) that passes `test`. */
  waitFor(test: (m: Msg) => boolean, timeoutMs = 20_000): Promise<Msg> {
    const have = this.messages.find(test)
    if (have) return Promise.resolve(have)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for a message; saw ${JSON.stringify(this.messages.slice(-3))}`,
            ),
          ),
        timeoutMs,
      )
      this.waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  /** Messages that are job updates, as plain job objects. */
  get jobs() {
    return this.messages
      .filter((m) => m.type === 'job')
      .map((m) => m.job as Record<string, unknown>)
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }
}
