import {
  InstagramError,
  READ_SCOPES,
  type IgAccountType,
  type IgInsights,
  type IgLongToken,
  type IgMedia,
  type IgProfile,
  type IgShortToken,
  type InstagramClient,
} from './client.js'

export interface RealOptions {
  appId: string
  appSecret: string
  /** Fixed in configuration. The only address Instagram is ever told to return to. */
  redirectUri: string
  apiVersion: string
  timeoutMs?: number
  fetch?: typeof fetch
}

const AUTHORIZE = 'https://www.instagram.com/oauth/authorize'
const TOKEN = 'https://api.instagram.com/oauth/access_token'
const GRAPH = 'https://graph.instagram.com'
const PAGE = 50

/**
 * Metrics asked for a Reel, from Meta's media insights reference. Some are marked "in development" there, so they are asked
 * for in two tries: all of them, and if Instagram refuses that, only the ones that have been there longest.
 */
const FULL_METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'ig_reels_avg_watch_time',
  'reels_skip_rate',
]
const CORE_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares', 'ig_reels_avg_watch_time']

/**
 * `ig_reels_avg_watch_time` is, to the best of my knowledge, reported in milliseconds. That is not confirmed on a page I could read, so
 * the conversion is one named constant: if a live account shows it is seconds, this is the only line that changes.
 */
export const AVG_WATCH_TIME_IS_MILLISECONDS = true

/** Graph API error codes that mean "slow down", and those that mean "this token no longer works". From Meta's error reference. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80004, 80006])
const AUTH_CODES = new Set([10, 102, 190])

const toAccountType = (v: unknown): IgAccountType => {
  const t = String(v ?? '').toUpperCase()
  if (t === 'BUSINESS') return 'business'
  if (t === 'MEDIA_CREATOR' || t === 'CREATOR') return 'creator'
  // Anything else, including a personal account and a missing field, is not a professional account.
  return 'personal'
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Meta's official Instagram API with Instagram Login, read-only. Everything about it that I could not confirm from Meta's pages
 * (see DECISIONS.md) is handled here and nowhere else: how a personal account shows up, whether a media is a Reel, which metrics a
 * Reel has, the unit of watch time. Failures leave as `InstagramError`, which holds no URL, token, code or message of Meta's.
 */
export class RealInstagramClient implements InstagramClient {
  readonly name = 'real' as const
  /** The highest share (0-100) of any call limit Instagram last reported using, so a sync can slow down before it is refused. */
  usagePercent = 0

  constructor(private readonly o: RealOptions) {}

  private get v() {
    return `${GRAPH}/${this.o.apiVersion}`
  }

  authorizeUrl(state: string): string {
    const u = new URL(AUTHORIZE)
    u.searchParams.set('client_id', this.o.appId)
    u.searchParams.set('redirect_uri', this.o.redirectUri)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('scope', READ_SCOPES.join(','))
    u.searchParams.set('state', state)
    return u.toString()
  }

  async exchangeCode(code: string): Promise<IgShortToken> {
    const body = await this.send(TOKEN, {
      method: 'POST',
      form: {
        client_id: this.o.appId,
        client_secret: this.o.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: this.o.redirectUri,
        code,
      },
    })
    // Instagram has answered both as a bare object and wrapped in `data`.
    const r = (Array.isArray(body?.data) ? body.data[0] : body) as
      Record<string, unknown> | undefined
    const token = typeof r?.access_token === 'string' ? r.access_token : null
    const userId = r?.user_id != null ? String(r.user_id) : null
    if (!token || !userId) throw new InstagramError('bad_request')
    const perms = r?.permissions
    const scopes = Array.isArray(perms)
      ? perms.map(String)
      : typeof perms === 'string'
        ? perms.split(/[,\s]+/).filter(Boolean)
        : null
    return { accessToken: token, userId, scopes }
  }

  async toLongLived(shortToken: string): Promise<IgLongToken> {
    return this.longToken(
      await this.send(`${GRAPH}/access_token`, {
        query: {
          grant_type: 'ig_exchange_token',
          client_secret: this.o.appSecret,
          access_token: shortToken,
        },
      }),
    )
  }

  async refresh(longToken: string): Promise<IgLongToken> {
    return this.longToken(
      await this.send(`${GRAPH}/refresh_access_token`, {
        query: { grant_type: 'ig_refresh_token', access_token: longToken },
      }),
    )
  }

  private longToken(body: Record<string, unknown> | undefined): IgLongToken {
    const token = typeof body?.access_token === 'string' ? body.access_token : null
    const expires = num(body?.expires_in)
    if (!token || !expires) throw new InstagramError('bad_request')
    return { accessToken: token, expiresInSec: expires }
  }

  async profile(token: string): Promise<IgProfile> {
    const body = await this.send(`${this.v}/me`, {
      query: { fields: 'user_id,username,account_type', access_token: token },
    })
    const id = body?.user_id ?? body?.id
    if (id == null || typeof body?.username !== 'string') throw new InstagramError('bad_request')
    return {
      userId: String(id),
      handle: `@${body.username}`,
      accountType: toAccountType(body.account_type),
    }
  }

  async listMedia(token: string, limit: number): Promise<IgMedia[]> {
    // Whether `media_product_type` is returned under Instagram Login was not confirmed: ask with it, and without it if refused.
    let withType = true
    let first: Record<string, unknown> | undefined
    try {
      first = await this.send(`${this.v}/me/media`, {
        query: {
          fields: 'id,media_type,media_product_type,timestamp',
          limit: String(PAGE),
          access_token: token,
        },
      })
    } catch (e) {
      if (!(e instanceof InstagramError) || e.kind !== 'bad_request') throw e
      withType = false
      first = await this.send(`${this.v}/me/media`, {
        query: { fields: 'id,media_type,timestamp', limit: String(PAGE), access_token: token },
      })
    }
    const out: IgMedia[] = []
    let page = first
    for (let i = 0; i < 20 && page; i++) {
      for (const m of (Array.isArray(page.data) ? page.data : []) as Array<
        Record<string, unknown>
      >) {
        if (m.media_type !== 'VIDEO' || typeof m.id !== 'string') continue
        // When Instagram says what surface it was posted on, only Reels count; when it does not, a video may be one.
        if (withType && m.media_product_type != null && m.media_product_type !== 'REELS') continue
        const at = new Date(String(m.timestamp ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
        if (Number.isNaN(at.getTime())) continue
        out.push({ id: m.id, postedAt: at })
      }
      const next = (page.paging as { next?: string } | undefined)?.next
      if (out.length >= limit || !next) break
      // The next page's address carries the token: only ever follow it to Instagram itself.
      if (new URL(next).hostname !== 'graph.instagram.com') break
      page = await this.send(next, {})
    }
    return out.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()).slice(0, limit)
  }

  async insights(token: string, mediaId: string): Promise<IgInsights | null> {
    let body: Record<string, unknown> | undefined
    for (const metrics of [FULL_METRICS, CORE_METRICS]) {
      try {
        body = await this.send(`${this.v}/${encodeURIComponent(mediaId)}/insights`, {
          query: { metric: metrics.join(','), access_token: token },
        })
        break
      } catch (e) {
        if (!(e instanceof InstagramError) || e.kind !== 'bad_request') throw e
      }
    }
    // Refused both times: Reels metrics do not apply to this media, so it is not a Reel.
    if (!body) return null

    const read = new Map<string, number>()
    for (const m of (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>) {
      const value =
        num((m.values as Array<{ value?: unknown }> | undefined)?.[0]?.value) ??
        num((m.total_value as { value?: unknown } | undefined)?.value)
      if (typeof m.name === 'string' && value !== null) read.set(m.name, value)
    }
    const watch = read.get('ig_reels_avg_watch_time')
    const skip = read.get('reels_skip_rate')
    return {
      views: read.get('views') ?? null,
      reach: read.get('reach') ?? null,
      likes: read.get('likes') ?? null,
      comments: read.get('comments') ?? null,
      saves: read.get('saved') ?? null,
      shares: read.get('shares') ?? null,
      avgWatchSec:
        watch === undefined ? null : AVG_WATCH_TIME_IS_MILLISECONDS ? watch / 1000 : watch,
      // A rate between 0 and 1; if it came as a percentage it is turned into one.
      skipRate: skip === undefined ? null : Math.max(0, Math.min(1, skip > 1 ? skip / 100 : skip)),
    }
  }

  /** One request, with Instagram's answers turned into our errors. */
  private async send(
    url: string,
    o: { method?: 'GET' | 'POST'; query?: Record<string, string>; form?: Record<string, string> },
  ): Promise<Record<string, unknown> | undefined> {
    const target = new URL(url)
    for (const [k, v] of Object.entries(o.query ?? {})) target.searchParams.set(k, v)
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(target, {
        method: o.method ?? 'GET',
        headers: o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
        body: o.form ? new URLSearchParams(o.form) : undefined,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      })
    } catch {
      throw new InstagramError('unavailable')
    }
    this.noteUsage(res.headers)
    let body: Record<string, unknown> | undefined
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = undefined
    }
    if (res.ok && !(body && 'error' in body)) return body
    throw failure(res, body)
  }

  private noteUsage(h: Headers) {
    let worst = 0
    for (const name of ['x-app-usage', 'x-business-use-case-usage']) {
      const raw = h.get(name)
      if (!raw) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        // `x-app-usage` is one record of percentages; `x-business-use-case-usage` is records in lists, keyed by account.
        const values = Object.values(parsed as object)
        const objects = Array.isArray(parsed)
          ? parsed
          : values.every((v) => typeof v === 'number')
            ? [parsed]
            : values.flat()
        for (const o of objects as Array<Record<string, unknown>>)
          for (const k of ['call_count', 'total_time', 'total_cputime']) {
            const v = num(o?.[k])
            if (v !== null) worst = Math.max(worst, v)
          }
      } catch {
        /* a header we cannot read tells us nothing */
      }
    }
    this.usagePercent = worst
  }
}

/** Reduces whatever Instagram said to a kind. Nothing of its message or URL is kept. */
function failure(res: Response, body: Record<string, unknown> | undefined): InstagramError {
  const err = (body?.error ?? {}) as { code?: unknown }
  const code = typeof err.code === 'number' ? err.code : undefined
  if (res.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    const retry = Number(res.headers.get('retry-after'))
    return new InstagramError('rate_limited', Number.isFinite(retry) && retry > 0 ? retry : 60)
  }
  if (
    res.status === 401 ||
    (code !== undefined && (AUTH_CODES.has(code) || (code >= 200 && code < 300)))
  ) {
    return new InstagramError('auth')
  }
  if (res.status >= 500) return new InstagramError('unavailable')
  return new InstagramError('bad_request')
}
