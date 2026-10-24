/**
 * Everything Lypcut asks of Instagram, behind one interface, so that no Meta type, URL or error format is known outside the
 * client that implements it, and so everything can run and be tested without a Meta app (see fake.ts).
 *
 * Read-only by construction: there is no method that posts, comments, messages or changes anything, and the only scopes ever
 * requested are the two below.
 */

/** The only permissions requested: the profile and the list of media, and the per-media numbers. Nothing that publishes, comments or messages. */
export const READ_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_insights',
] as const

export type IgAccountType = 'business' | 'creator' | 'personal'

export interface IgShortToken {
  accessToken: string
  userId: string
  /** The permissions the person actually approved, if Instagram said. */
  scopes: string[] | null
}

export interface IgLongToken {
  accessToken: string
  /** Seconds until it stops working: about 60 days. */
  expiresInSec: number
}

export interface IgProfile {
  userId: string
  handle: string
  accountType: IgAccountType
}

export interface IgMedia {
  id: string
  postedAt: Date
}

/** One reading of a Reel's numbers. A number Instagram did not return is null: never 0. */
export interface IgInsights {
  views: number | null
  reach: number | null
  likes: number | null
  comments: number | null
  saves: number | null
  shares: number | null
  /** Seconds, as Instagram reports it. */
  avgWatchSec: number | null
  /** 0-1: the share who left in the first three seconds. */
  skipRate: number | null
}

export type InstagramErrorKind =
  /** The token no longer works (expired, revoked, permission removed): the person has to connect again. */
  | 'auth'
  /** Too many calls: wait, then try again. */
  | 'rate_limited'
  /** Instagram is down or unreachable: try again later. */
  | 'unavailable'
  /** Instagram refused the request itself (a bad or used code, a metric that does not apply to this media). */
  | 'bad_request'

/**
 * A failure from Instagram, reduced to what a caller may act on. It never carries a URL, a token, a code or anything
 * Instagram said: only the kind, and how long to wait if it is a rate limit.
 */
export class InstagramError extends Error {
  constructor(
    readonly kind: InstagramErrorKind,
    readonly retryAfterSec?: number,
  ) {
    super(`Instagram: ${kind}`)
    this.name = 'InstagramError'
  }
}

export interface InstagramClient {
  readonly name: 'real' | 'fake'
  /** The highest share (0-100) of any call limit Instagram last said was used, if it says. A sync slows down when it is high. */
  readonly usagePercent?: number
  /** Where to send the person to approve. `state` comes back unchanged on the callback. */
  authorizeUrl(state: string): string
  /** Trades the one-time code from the callback for a short-lived token. */
  exchangeCode(code: string): Promise<IgShortToken>
  /** Trades the short-lived token for one that lasts about 60 days. */
  toLongLived(shortToken: string): Promise<IgLongToken>
  /** Another 60 days for a token that is still valid and at least a day old. */
  refresh(longToken: string): Promise<IgLongToken>
  profile(token: string): Promise<IgProfile>
  /** The account's recent video media that may be Reels, newest first, at most `limit`. */
  listMedia(token: string, limit: number): Promise<IgMedia[]>
  /** The numbers for one Reel, or null if this media is not a Reel (it has no Reels metrics). */
  insights(token: string, mediaId: string): Promise<IgInsights | null>
}
