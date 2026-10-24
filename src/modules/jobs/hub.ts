import type { Redis } from 'ioredis'
import type { WebSocket } from 'ws'
import { z } from 'zod'
import type { AppDeps } from '../../app/types.js'
import type { AuthUser } from '../../app/plugins/auth.js'
import type { Log } from '../../lib/log.js'
import { JOB_EVENTS_CHANNEL, type JobEvent } from '../../pipeline/reporter.js'
import { bullConnectionOptions, createRedis } from '../../queue/connection.js'
import { toJobDto } from './dto.js'
import { JobService } from './service.js'

/** The front end's protocol: it sends one of these, and is sent `{type:'job'}` or `{type:'error'}`. */
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), jobId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), jobId: z.string() }),
  z.object({ type: z.literal('ping') }),
])

const MAX_SUBSCRIPTIONS_PER_SOCKET = 20
const MAX_MESSAGE_BYTES = 4096
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

interface Client {
  socket: WebSocket
  user: AuthUser
  jobs: Set<string>
  alive: boolean
}

/**
 * Pushes job progress to browsers. Every message is the job's complete current state, never a delta, so:
 *   - a client that reconnects simply subscribes again and is told where things stand, and loses nothing;
 *   - messages that arrive late, twice or out of order cannot corrupt anything.
 * The worker announces changes on a Redis channel; this process turns each announcement into one read of the
 * job's row (bursts are coalesced) and fans the result out to whoever is watching that job. A slow timer also
 * re-reads watched, unfinished jobs, so even a lost announcement shows up within a few seconds.
 */
export class JobHub {
  private readonly clients = new Set<Client>()
  private readonly watchers = new Map<string, Set<Client>>()
  /** The last message sent per job, so an unchanged state is not sent twice. */
  private readonly lastSent = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private flushScheduled = false
  private subscriber?: Redis
  private timers: NodeJS.Timeout[] = []
  private readonly service: JobService

  constructor(
    private readonly deps: AppDeps,
    private readonly log: Log,
  ) {
    this.service = new JobService(deps)
  }

  async start(): Promise<void> {
    const sub = createRedis(this.deps.config, bullConnectionOptions)
    sub.on('error', () => undefined)
    sub.on('message', (_channel, raw) => {
      try {
        this.touch((JSON.parse(raw) as JobEvent).jobId)
      } catch {
        /* a malformed announcement is ignored: the periodic refresh covers it */
      }
    })
    await sub.subscribe(JOB_EVENTS_CHANNEL)
    this.subscriber = sub

    const { JOBS_WS_REFRESH_MS, JOBS_WS_PING_MS } = this.deps.config
    this.timers.push(
      setInterval(() => this.refreshWatched(), JOBS_WS_REFRESH_MS),
      setInterval(() => this.ping(), JOBS_WS_PING_MS),
    )
    for (const t of this.timers) t.unref()
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const c of this.clients) c.socket.close(1001, 'server shutting down')
    this.clients.clear()
    this.watchers.clear()
    this.subscriber?.disconnect()
  }

  /** Take over a connection that has already been authenticated. */
  attach(socket: WebSocket, user: AuthUser): void {
    const client: Client = { socket, user, jobs: new Set(), alive: true }
    this.clients.add(client)

    socket.on('pong', () => {
      client.alive = true
    })
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary || data.length > MAX_MESSAGE_BYTES) return
      void this.onMessage(client, data.toString()).catch((e) =>
        this.log.warn({ err: e }, 'job feed message failed'),
      )
    })
    socket.on('close', () => this.drop(client))
    socket.on('error', () => this.drop(client))
  }

  /* ------------------------------ client messages ------------------------------ */

  private async onMessage(client: Client, raw: string): Promise<void> {
    let parsed
    try {
      parsed = message.safeParse(JSON.parse(raw))
    } catch {
      return // not JSON: ignored, as the mock ignores it
    }
    if (!parsed.success) return
    const msg = parsed.data

    if (msg.type === 'ping') return this.send(client, { type: 'pong' })
    if (msg.type === 'unsubscribe') return this.unwatch(client, msg.jobId)

    // subscribe: only your own jobs. Anything else, real or not, gets the same answer.
    const row = await this.service.find(client.user.id, msg.jobId)
    if (!row || (client.jobs.size >= MAX_SUBSCRIPTIONS_PER_SOCKET && !client.jobs.has(msg.jobId))) {
      return this.send(client, { type: 'error', jobId: msg.jobId, message: 'Unknown job' })
    }
    if (!client.jobs.has(msg.jobId)) {
      client.jobs.add(msg.jobId)
      let set = this.watchers.get(msg.jobId)
      if (!set) this.watchers.set(msg.jobId, (set = new Set()))
      set.add(client)
    }
    // Always answer with the current state, so a subscriber (or a reconnecting one) is never left waiting.
    const payload = { type: 'job', job: toJobDto(row) }
    this.lastSent.set(msg.jobId, JSON.stringify(payload))
    this.send(client, payload)
  }

  private unwatch(client: Client, jobId: string) {
    client.jobs.delete(jobId)
    const set = this.watchers.get(jobId)
    set?.delete(client)
    if (set && !set.size) {
      this.watchers.delete(jobId)
      this.lastSent.delete(jobId)
    }
  }

  private drop(client: Client) {
    for (const id of [...client.jobs]) this.unwatch(client, id)
    this.clients.delete(client)
  }

  /* ------------------------------ updates out ------------------------------ */

  /** Something about this job changed: read it once, soon. Many changes in a burst cost one read. */
  private touch(jobId: string) {
    if (!this.watchers.has(jobId)) return
    this.dirty.add(jobId)
    if (this.flushScheduled) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      const ids = [...this.dirty]
      this.dirty.clear()
      for (const id of ids)
        void this.publish(id).catch((e) => this.log.warn({ err: e }, 'job feed read failed'))
    })
  }

  private async publish(jobId: string): Promise<void> {
    const watchers = this.watchers.get(jobId)
    if (!watchers?.size) return
    const owner = [...watchers][0]!.user.id
    const row = await this.service.find(owner, jobId)
    if (!row) return
    const payload = { type: 'job', job: toJobDto(row) }
    const text = JSON.stringify(payload)
    if (this.lastSent.get(jobId) === text) return
    this.lastSent.set(jobId, text)
    for (const c of watchers) this.send(c, payload)
  }

  /** Safety net: re-read every watched job that has not finished. */
  private refreshWatched() {
    for (const jobId of this.watchers.keys()) {
      const last = this.lastSent.get(jobId)
      const done =
        last && TERMINAL.has((JSON.parse(last) as { job: { status: string } }).job.status)
      if (!done) this.touch(jobId)
    }
  }

  private ping() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate()
        this.drop(c)
        continue
      }
      c.alive = false
      c.socket.ping()
    }
  }

  private send(client: Client, payload: unknown) {
    if (client.socket.readyState !== client.socket.OPEN) return
    // A client that is not keeping up is not worth buffering for: it will catch up on the next snapshot.
    if (client.socket.bufferedAmount > 1_000_000) return
    client.socket.send(JSON.stringify(payload))
  }
}
