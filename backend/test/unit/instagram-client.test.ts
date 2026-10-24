import { describe, expect, it } from 'vitest'
import { InstagramError, READ_SCOPES } from '../../src/style/instagram/client.js'
import { FakeInstagramClient } from '../../src/style/instagram/fake.js'
import { createInstagramClient } from '../../src/style/instagram/index.js'
import { RealInstagramClient } from '../../src/style/instagram/real.js'

interface Sent {
  method: string
  url: URL
  form: URLSearchParams | null
}

/** Instagram, played by a script: answers by path, and remembers every request made. */
function instagram(
  answer: (
    req: Sent,
    n: number,
  ) => Response | Record<string, unknown> | Promise<Response | Record<string, unknown>>,
) {
  const sent: Sent[] = []
  const client = new RealInstagramClient({
    appId: 'APPID',
    appSecret: 'APPSECRET',
    redirectUri: 'https://api.example.com/api/style/callback',
    apiVersion: 'v26.0',
    fetch: async (input, init) => {
      const req: Sent = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        form: init?.body instanceof URLSearchParams ? init.body : null,
      }
      sent.push(req)
      const out = await answer(req, sent.length)
      return out instanceof Response
        ? out
        : new Response(JSON.stringify(out), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
    },
  })
  return { client, sent }
}
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
const fails = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as InstagramError
  }
  throw new Error('expected a failure')
}

describe('sending the person to Instagram', () => {
  it('asks for the two read permissions and nothing that publishes, comments or messages', () => {
    const { client } = instagram(() => ({}))
    const url = new URL(client.authorizeUrl('S-TATE'))
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('APPID')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('S-TATE')
    expect(url.searchParams.get('scope')).toBe(
      'instagram_business_basic,instagram_business_manage_insights',
    )
    expect(READ_SCOPES).toEqual(['instagram_business_basic', 'instagram_business_manage_insights'])
    expect(url.searchParams.get('scope')).not.toMatch(/publish|comments|messages/)
  })

  it('always returns to the one address in configuration', () => {
    const { client } = instagram(() => ({}))
    expect(new URL(client.authorizeUrl('x')).searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/style/callback',
    )
    // There is nowhere to pass another.
    expect(client.authorizeUrl.length).toBe(1)
  })
})

describe('the tokens', () => {
  it('trades the code, as a form posted to Instagram, for a short-lived token and the permissions approved', async () => {
    const { client, sent } = instagram(() => ({
      access_token: 'SHORT',
      user_id: 12345,
      permissions: 'instagram_business_basic,instagram_business_manage_insights',
    }))
    expect(await client.exchangeCode('THE-CODE')).toEqual({
      accessToken: 'SHORT',
      userId: '12345',
      scopes: ['instagram_business_basic', 'instagram_business_manage_insights'],
    })
    const [req] = sent
    expect(req!.method).toBe('POST')
    expect(req!.url.href).toBe('https://api.instagram.com/oauth/access_token')
    expect(Object.fromEntries(req!.form!)).toEqual({
      client_id: 'APPID',
      client_secret: 'APPSECRET',
      grant_type: 'authorization_code',
      redirect_uri: 'https://api.example.com/api/style/callback',
      code: 'THE-CODE',
    })
  })

  it('reads the answer however it comes: bare or wrapped, permissions as a list or text or absent', async () => {
    const wrapped = instagram(() => ({
      data: [{ access_token: 'T', user_id: '9', permissions: ['a', 'b'] }],
    }))
    expect(await wrapped.client.exchangeCode('c')).toMatchObject({
      userId: '9',
      scopes: ['a', 'b'],
    })
    const bare = instagram(() => ({ access_token: 'T', user_id: 9 }))
    expect((await bare.client.exchangeCode('c')).scopes).toBeNull()
    expect(
      (await fails(instagram(() => ({ access_token: 'T' })).client.exchangeCode('c'))).kind,
    ).toBe('bad_request')
  })

  it('trades the short-lived token for a long-lived one, and renews it, on Instagram’s own address', async () => {
    const { client, sent } = instagram(() => ({
      access_token: 'LONG',
      token_type: 'bearer',
      expires_in: 5183944,
    }))
    expect(await client.toLongLived('SHORT')).toEqual({
      accessToken: 'LONG',
      expiresInSec: 5183944,
    })
    expect(await client.refresh('LONG')).toEqual({ accessToken: 'LONG', expiresInSec: 5183944 })
    expect(sent[0]!.url.origin + sent[0]!.url.pathname).toBe(
      'https://graph.instagram.com/access_token',
    )
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      grant_type: 'ig_exchange_token',
      client_secret: 'APPSECRET',
      access_token: 'SHORT',
    })
    expect(sent[1]!.url.pathname).toBe('/refresh_access_token')
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({
      grant_type: 'ig_refresh_token',
      access_token: 'LONG',
    })
    expect((await fails(instagram(() => ({ access_token: 'x' })).client.refresh('t'))).kind).toBe(
      'bad_request',
    )
  })
})

describe('the account', () => {
  const profile = (account_type?: string) =>
    instagram(() => ({
      user_id: '555',
      username: 'aarav.builds',
      ...(account_type ? { account_type } : {}),
    })).client.profile('T')

  it('tells a Business or Creator account from anything else', async () => {
    expect(await profile('BUSINESS')).toEqual({
      userId: '555',
      handle: '@aarav.builds',
      accountType: 'business',
    })
    expect((await profile('MEDIA_CREATOR')).accountType).toBe('creator')
    // A personal account, an unknown value and no value at all are all "not professional".
    expect((await profile('PERSONAL')).accountType).toBe('personal')
    expect((await profile('SOMETHING_NEW')).accountType).toBe('personal')
    expect((await profile()).accountType).toBe('personal')
  })

  it('asks only for the id, the name and the type', async () => {
    const { client, sent } = instagram(() => ({ user_id: '1', username: 'a' }))
    await client.profile('T')
    expect(sent[0]!.url.pathname).toBe('/v26.0/me')
    expect(sent[0]!.url.searchParams.get('fields')).toBe('user_id,username,account_type')
  })
})

describe('the list of Reels', () => {
  const media = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
    id,
    media_type: 'VIDEO',
    media_product_type: 'REELS',
    timestamp: ts,
    ...over,
  })

  it('keeps Reels only, newest first and no more than asked for', async () => {
    const { client } = instagram(() => ({
      data: [
        media('a', '2026-09-01T10:00:00+0000'),
        media('b', '2026-10-01T10:00:00+0000'),
        media('img', '2026-10-02T10:00:00+0000', { media_type: 'IMAGE' }),
        media('feed', '2026-10-03T10:00:00+0000', { media_product_type: 'FEED' }),
        media('c', '2026-08-01T10:00:00+0000'),
      ],
    }))
    const list = await client.listMedia('T', 2)
    expect(list.map((m) => m.id)).toEqual(['b', 'a'])
    expect(list[0]!.postedAt.toISOString()).toBe('2026-10-01T10:00:00.000Z')
  })

  it('asks again without the surface field if Instagram refuses it, and then treats every video as a possible Reel', async () => {
    const { client, sent } = instagram((req) =>
      req.url.searchParams.get('fields')!.includes('media_product_type')
        ? failure(400, { error: { code: 100, message: 'nonexisting field' } })
        : { data: [{ id: 'v', media_type: 'VIDEO', timestamp: '2026-10-01T10:00:00+0000' }] },
    )
    expect((await client.listMedia('T', 5)).map((m) => m.id)).toEqual(['v'])
    expect(sent.map((s) => s.url.searchParams.get('fields'))).toEqual([
      'id,media_type,media_product_type,timestamp',
      'id,media_type,timestamp',
    ])
  })

  it('follows pages, but only to Instagram: the next address carries the token', async () => {
    const { client, sent } = instagram((_req, n) =>
      n === 1
        ? {
            data: [media('a', '2026-10-01T10:00:00+0000')],
            paging: { next: 'https://graph.instagram.com/v26.0/me/media?after=X&access_token=T' },
          }
        : { data: [media('b', '2026-09-01T10:00:00+0000')] },
    )
    expect((await client.listMedia('T', 10)).map((m) => m.id)).toEqual(['a', 'b'])
    expect(sent).toHaveLength(2)

    const evil = instagram(() => ({
      data: [media('a', '2026-10-01T10:00:00+0000')],
      paging: { next: 'https://evil.example.com/steal?access_token=T' },
    }))
    expect((await evil.client.listMedia('T', 10)).map((m) => m.id)).toEqual(['a'])
    expect(evil.sent).toHaveLength(1)
  })
})

describe('a Reel’s numbers', () => {
  const answer = (rows: Array<[string, number]>) => ({
    data: rows.map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] })),
  })

  it('maps each metric, turns watch time into seconds and keeps what Instagram did not say as null, never 0', async () => {
    const { client, sent } = instagram(() =>
      answer([
        ['views', 9000],
        ['reach', 7000],
        ['likes', 800],
        ['comments', 0],
        ['saved', 300],
        ['shares', 120],
        ['ig_reels_avg_watch_time', 8400],
      ]),
    )
    expect(await client.insights('T', 'm1')).toEqual({
      views: 9000,
      reach: 7000,
      likes: 800,
      comments: 0,
      saves: 300,
      shares: 120,
      avgWatchSec: 8.4,
      skipRate: null,
    })
    expect(sent[0]!.url.pathname).toBe('/v26.0/m1/insights')
    expect(sent[0]!.url.searchParams.get('metric')).toBe(
      'views,reach,likes,comments,saved,shares,ig_reels_avg_watch_time,reels_skip_rate',
    )
  })

  it('reads either shape of value, and a skip rate given as a fraction or as a percentage', async () => {
    const total = instagram(() => ({
      data: [
        { name: 'likes', total_value: { value: 5 } },
        { name: 'reels_skip_rate', values: [{ value: 0.4 }] },
      ],
    }))
    expect(await total.client.insights('T', 'm')).toMatchObject({ likes: 5, skipRate: 0.4 })
    const pct = instagram(() => answer([['reels_skip_rate', 35]]))
    expect((await pct.client.insights('T', 'm'))!.skipRate).toBe(0.35)
  })

  it('asks again for only the long-standing metrics if the newer ones are refused', async () => {
    const { client, sent } = instagram((req) =>
      req.url.searchParams.get('metric')!.includes('reels_skip_rate')
        ? failure(400, { error: { code: 100 } })
        : answer([
            ['likes', 1],
            ['reach', 10],
          ]),
    )
    expect(await client.insights('T', 'm')).toMatchObject({
      likes: 1,
      reach: 10,
      views: null,
      skipRate: null,
    })
    expect(sent[1]!.url.searchParams.get('metric')).toBe(
      'reach,likes,comments,saved,shares,ig_reels_avg_watch_time',
    )
  })

  it('is null for a media Instagram has no Reels numbers for: it is not a Reel', async () => {
    const { client } = instagram(() => failure(400, { error: { code: 100 } }))
    expect(await client.insights('T', 'photo')).toBeNull()
  })
})

describe('when Instagram says no', () => {
  const kind = async (res: Response | (() => never)) => {
    const { client } = instagram(typeof res === 'function' ? res : () => res)
    return (await fails(client.insights('SECRET-TOKEN', 'm'))) as InstagramError
  }

  it('a token that no longer works is auth', async () => {
    expect((await kind(failure(400, { error: { code: 190, message: 'expired' } }))).kind).toBe(
      'auth',
    )
    expect((await kind(failure(401, {}))).kind).toBe('auth')
    expect((await kind(failure(403, { error: { code: 10 } }))).kind).toBe('auth')
  })

  it('too many calls is rate_limited, with how long to wait', async () => {
    const a = await kind(failure(429, {}, { 'retry-after': '120' }))
    expect(a).toMatchObject({ kind: 'rate_limited', retryAfterSec: 120 })
    expect(await kind(failure(400, { error: { code: 4 } }))).toMatchObject({
      kind: 'rate_limited',
      retryAfterSec: 60,
    })
    expect((await kind(failure(400, { error: { code: 17 } }))).kind).toBe('rate_limited')
  })

  it('an outage is unavailable, whether Instagram answers 5xx or cannot be reached', async () => {
    expect((await kind(failure(503, {}))).kind).toBe('unavailable')
    expect(
      (
        await kind(() => {
          throw new Error('socket hang up')
        })
      ).kind,
    ).toBe('unavailable')
  })

  it('anything else is bad_request', async () => {
    const refused = (res: Response) => fails(instagram(() => res).client.profile('T'))
    expect((await refused(failure(400, { error: { code: 100 } }))).kind).toBe('bad_request')
    expect((await refused(failure(404, {}))).kind).toBe('bad_request')
  })

  it('and the error holds none of what was sent or said: no token, no address, no message', async () => {
    const e = await kind(
      failure(400, {
        error: {
          code: 190,
          message: 'Invalid OAuth access token SECRET-TOKEN',
          fbtrace_id: 'trace123',
        },
      }),
    )
    const text = `${e.message} ${e.name} ${JSON.stringify(e)} ${e.stack?.split('\n')[0]}`
    for (const leak of [
      'SECRET-TOKEN',
      'graph.instagram.com',
      'trace123',
      'Invalid OAuth',
      'access_token',
    ])
      expect(text).not.toContain(leak)
  })
})

describe('being read-only, and polite', () => {
  it('only ever reads: GETs to Instagram, and the one POST that trades the code', async () => {
    const { client, sent } = instagram((req) => {
      if (req.url.pathname === '/oauth/access_token') return { access_token: 'S', user_id: 1 }
      if (req.url.pathname.endsWith('/me'))
        return { user_id: '1', username: 'a', account_type: 'BUSINESS' }
      if (req.url.pathname.endsWith('/insights')) return { data: [] }
      if (req.url.pathname.endsWith('/me/media')) return { data: [] }
      return { access_token: 'L', expires_in: 100 }
    })
    await client.exchangeCode('c')
    await client.toLongLived('s')
    await client.refresh('l')
    await client.profile('t')
    await client.listMedia('t', 3)
    await client.insights('t', 'm')
    const writes = sent.filter((s) => s.method !== 'GET')
    expect(writes.map((w) => `${w.method} ${w.url.host}${w.url.pathname}`)).toEqual([
      'POST api.instagram.com/oauth/access_token',
    ])
    expect(new Set(sent.map((s) => s.url.host))).toEqual(
      new Set(['api.instagram.com', 'graph.instagram.com']),
    )
  })

  it('notes how much of its allowance Instagram says is used, from either usage header', async () => {
    const a = instagram(() =>
      failure(
        400,
        { error: { code: 100 } },
        { 'x-app-usage': '{"call_count":82,"total_time":10,"total_cputime":5}' },
      ),
    )
    await a.client.insights('t', 'm').catch(() => undefined)
    expect(a.client.usagePercent).toBe(82)
    const b = instagram(() => ({ data: [] }))
    expect(b.client.usagePercent).toBe(0)
    const biz = instagram(
      () =>
        new Response('{"data":[]}', {
          headers: { 'x-business-use-case-usage': '{"123":[{"call_count":91,"total_cputime":3}]}' },
        }),
    )
    await biz.client.insights('t', 'm')
    expect(biz.client.usagePercent).toBe(91)
  })
})

describe('the stand-in Instagram', () => {
  it('has a creator, a business and a personal account, and Reels with different numbers', async () => {
    const c = new FakeInstagramClient()
    const short = await c.exchangeCode('fake-creator')
    const long = await c.toLongLived(short.accessToken)
    expect((await c.profile(long.accessToken)).accountType).toBe('creator')
    expect(
      (
        await c.profile(
          (await c.toLongLived((await c.exchangeCode('fake-personal')).accessToken)).accessToken,
        )
      ).accountType,
    ).toBe('personal')
    const media = await c.listMedia(long.accessToken, 30)
    expect(media.length).toBe(14)
    const views = (await Promise.all(media.map((m) => c.insights(long.accessToken, m.id)))).map(
      (i) => i!.views,
    )
    expect(new Set(views).size).toBeGreaterThan(8)
    expect(await c.insights(long.accessToken, media[0]!.id)).toEqual(
      await c.insights(long.accessToken, media[0]!.id),
    )
  })

  it('can have its tokens revoked and its calls made to fail, for tests', async () => {
    const c = new FakeInstagramClient()
    const t = (await c.toLongLived((await c.exchangeCode('fake-creator')).accessToken)).accessToken
    c.script.revoked.add('17841400000000001')
    expect((await fails(c.listMedia(t, 5))).kind).toBe('auth')
    c.script.revoked.clear()
    c.script.failNext.set('listMedia', new InstagramError('unavailable'))
    expect((await fails(c.listMedia(t, 5))).kind).toBe('unavailable')
    expect((await c.listMedia(t, 5)).length).toBe(5)
    expect((await fails(c.exchangeCode('not-a-code'))).kind).toBe('bad_request')
  })
})

describe('which Instagram is used', () => {
  const base = {
    INSTAGRAM_CLIENT: 'auto' as const,
    INSTAGRAM_API_VERSION: 'v26.0',
    NODE_ENV: 'development' as const,
  }
  const set = {
    INSTAGRAM_APP_ID: 'id',
    INSTAGRAM_APP_SECRET: 's',
    INSTAGRAM_REDIRECT_URI: 'https://x.example/cb',
  }

  it('the real one when the three settings are there, the stand-in when they are not, and none in production without them', () => {
    expect(createInstagramClient({ ...base, ...set })?.name).toBe('real')
    expect(createInstagramClient(base)?.name).toBe('fake')
    expect(createInstagramClient({ ...base, NODE_ENV: 'production' })).toBeNull()
    expect(createInstagramClient({ ...base, NODE_ENV: 'production', ...set })?.name).toBe('real')
    expect(createInstagramClient({ ...base, INSTAGRAM_CLIENT: 'fake' })?.name).toBe('fake')
  })
})
