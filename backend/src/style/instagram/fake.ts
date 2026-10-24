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

/** Accounts the stand-in knows, by the `code` its consent page sends back. */
export const FAKE_ACCOUNTS: Record<
  string,
  { userId: string; handle: string; accountType: IgAccountType }
> = {
  'fake-creator': { userId: '17841400000000001', handle: '@aarav.builds', accountType: 'creator' },
  'fake-business': { userId: '17841400000000002', handle: '@lypcut.shop', accountType: 'business' },
  'fake-personal': { userId: '17841400000000003', handle: '@just.me', accountType: 'personal' },
}

const DAY = 86_400_000
const REELS = 14

const hash = (s: string) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0) / 4294967296
}

/**
 * Instagram without Meta: a fixed account with fixed Reels, so everything runs and tests with no Meta app. Tokens look like
 * `fake-short:<user>` and `fake-long:<user>:<n>`. Tests steer it through `script`: revoke a person's token, fail a call, make it
 * slow down.
 */
export class FakeInstagramClient implements InstagramClient {
  readonly name = 'fake' as const
  usagePercent = 0
  /** Calls made, by method, for tests that check what was and was not asked of Instagram. */
  readonly calls: string[] = []
  readonly script = {
    /** Users whose tokens no longer work: every call with one answers `auth`. */
    revoked: new Set<string>(),
    /** The next call to this method fails this way, once. */
    failNext: new Map<string, InstagramError>(),
    /** Every call to this method fails this way until cleared. */
    failAlways: new Map<string, InstagramError>(),
    /** Media ids that are not Reels (they have no Reels metrics). */
    notReels: new Set<string>(),
    /** How many Reels the account has. */
    reels: REELS,
  }
  private serial = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  private enter(method: string, token?: string) {
    this.calls.push(method)
    const once = this.script.failNext.get(method)
    if (once) {
      this.script.failNext.delete(method)
      throw once
    }
    const always = this.script.failAlways.get(method)
    if (always) throw always
    if (token !== undefined) {
      const user = token.split(':')[1]
      if (!token.startsWith('fake-') || (user && this.script.revoked.has(user)))
        throw new InstagramError('auth')
    }
  }

  authorizeUrl(state: string): string {
    // The stand-in's own consent page, served by this API when the fake client is in use.
    return `/api/style/fake-instagram/authorize?state=${encodeURIComponent(state)}`
  }

  async exchangeCode(code: string): Promise<IgShortToken> {
    this.enter('exchangeCode')
    const account = FAKE_ACCOUNTS[code]
    if (!account) throw new InstagramError('bad_request')
    return {
      accessToken: `fake-short:${account.userId}`,
      userId: account.userId,
      scopes: [...READ_SCOPES],
    }
  }

  async toLongLived(shortToken: string): Promise<IgLongToken> {
    this.enter('toLongLived', shortToken)
    return {
      accessToken: `fake-long:${shortToken.split(':')[1]}:${++this.serial}`,
      expiresInSec: 60 * 86_400,
    }
  }

  async refresh(longToken: string): Promise<IgLongToken> {
    this.enter('refresh', longToken)
    return {
      accessToken: `fake-long:${longToken.split(':')[1]}:${++this.serial}`,
      expiresInSec: 60 * 86_400,
    }
  }

  async profile(token: string): Promise<IgProfile> {
    this.enter('profile', token)
    const user = token.split(':')[1]
    const account = Object.values(FAKE_ACCOUNTS).find((a) => a.userId === user)
    if (!account) throw new InstagramError('auth')
    return { ...account }
  }

  async listMedia(token: string, limit: number): Promise<IgMedia[]> {
    this.enter('listMedia', token)
    const user = token.split(':')[1]!
    const now = this.now().getTime()
    return Array.from({ length: Math.min(limit, this.script.reels) }, (_, i) => ({
      id: `fake_${user}_${i}`,
      postedAt: new Date(now - (i * 6 + 5) * DAY),
    }))
  }

  async insights(token: string, mediaId: string): Promise<IgInsights | null> {
    this.enter('insights', token)
    if (this.script.notReels.has(mediaId)) return null
    // Steady, different numbers per Reel: some do well, most do not.
    const r = hash(mediaId)
    const views = Math.round(2000 + r * r * 60_000)
    const rate = (lo: number, hi: number, k: string) =>
      lo + (hi - lo) * hash(mediaId + k) * (0.5 + r / 2)
    return {
      views,
      reach: Math.round(views * 0.82),
      likes: Math.round(views * rate(0.02, 0.09, 'l')),
      comments: Math.round(views * rate(0.0005, 0.004, 'c')),
      saves: Math.round(views * rate(0.002, 0.04, 's')),
      shares: Math.round(views * rate(0.001, 0.03, 'h')),
      avgWatchSec: Math.round((4 + rate(0, 14, 'w')) * 10) / 10,
      skipRate: Math.round(rate(0.15, 0.6, 'k') * 100) / 100,
    }
  }
}
