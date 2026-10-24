import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { searchInMemory } from '../../src/modules/search/match.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { LINES } from '../helpers/transcript-fixture.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

type Setup = Person & ReadyProject
async function setup(lines: typeof LINES | true = true): Promise<Setup> {
  const person = await signup(t)
  return { ...person, ...(await readyProject(t, person, { content: lines })) }
}
const find = (s: Setup, q: string, extra = '') =>
  s.c.get(`/api/projects/${s.projectId}/search?q=${encodeURIComponent(q)}${extra}`)

/** What the algorithm gives for the same data without any database narrowing. */
function expected(s: Setup, q: string, limit = 8) {
  const tr = s.content!.transcript
  return searchInMemory(
    tr.sentences.map((x) => ({ idx: x.idx, from: x.from, to: x.to, start: x.start, end: x.end })),
    tr.words.map((w) => ({ norm: w.norm, dev: w.dev })),
    q,
    limit,
  )
}

describe('searching a transcript', () => {
  it('returns the front end’s SearchResult, best first', async () => {
    const s = await setup()
    const res = await find(s, 'funding')
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(1)
    for (const r of res.body) {
      expect(Object.keys(r).sort()).toEqual([
        'end',
        'from',
        'id',
        'matched',
        'relevance',
        'start',
        'thumbSeed',
        'to',
      ])
      expect(r.id).toMatch(/^sr_\d+$/)
      expect(r.relevance).toBeGreaterThanOrEqual(40)
      expect(r.relevance).toBeLessThanOrEqual(99)
      expect(r.end).toBeGreaterThan(r.start)
    }
    const scores = res.body.map((r: { relevance: number }) => r.relevance)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('finds a moment from a Roman word, a Devanagari word, or a whole sentence', async () => {
    const s = await setup()
    const words = s.content!.transcript.words
    for (const q of [
      'funding',
      'फंडिंग',
      'where I talk about funding',
      'term sheet',
      'टर्म शीट',
      'pitch deck',
    ]) {
      const res = await find(s, q)
      expect(res.body.length, q).toBeGreaterThan(0)
      // The matched word indices point at real words of the transcript, inside the clip's range.
      for (const m of res.body[0].matched) {
        expect(m, q).toBeGreaterThanOrEqual(res.body[0].from)
        expect(m, q).toBeLessThan(res.body[0].to)
        expect(words[m]).toBeTruthy()
      }
    }
  })

  it('English finds Devanagari and Devanagari finds English, through the topic groups too', async () => {
    const s = await setup()
    const words = s.content!.transcript.words
    const top = async (q: string) => {
      const r = (await find(s, q)).body[0]
      return words
        .slice(r.from, r.to)
        .map((w) => `${w.text} ${w.dev}`)
        .join(' ')
        .toLowerCase()
    }
    expect(await top('investors')).toMatch(/इन्वेस्टर/)
    expect(await top('इन्वेस्टर्स')).toMatch(/investor|इन्वेस्टर/)
    expect(await top('paisa')).toMatch(/funding|पैसा|फंडिंग/)
    expect(await top('galti')).toMatch(/galti|गलती/)
  })

  it('finds a word however speech recognition happened to spell it', async () => {
    // Whisper small, on real Hindi speech, wrote "funding" as फुंदिंग and "raise" as रेस.
    const lines: typeof LINES = [
      { speaker: 'host', text: 'नमस्ते दोस्तों आज हम बात करेंगे कि फुंदिंग कैसे रेस करते हैं।' },
      { speaker: 'guest', text: 'मेरी सबसे बड़ी गल्ती थी चालिस लाक रुपै खर्ज कर दिये।' },
      { speaker: 'host', text: 'यह एक बिलकुल अलग बात है जिसका इससे कोई लेना देना नहीं है।' },
    ]
    const s = await setup(lines)
    const funding = await find(s, 'funding')
    expect(funding.body).toHaveLength(1)
    expect(funding.body[0].matched.length).toBeGreaterThan(0)
    // Roman spelling variants of a stored word, too.
    for (const q of ['phunding', 'fundding', 'galti', 'lakh'])
      expect((await find(s, q)).body.length, q).toBeGreaterThan(0)
  })

  it('returns nothing for a query with nothing to find', async () => {
    const s = await setup()
    for (const q of ['zzxqv', 'where I talk about the', '!!!', ''])
      expect((await find(s, q)).body, JSON.stringify(q)).toEqual([])
    // A single character is not a search (the editor only searches from two).
    expect((await find(s, 'f')).body).toEqual([])
    expect((await s.c.get(`/api/projects/${s.projectId}/search`)).body).toEqual([])
  })

  it('respects the limit, and refuses one that makes no sense', async () => {
    const s = await setup()
    expect((await find(s, 'funding', '&limit=1')).body).toHaveLength(1)
    expect((await find(s, 'funding', '&limit=20')).status).toBe(200)
    expect((await find(s, 'funding', '&limit=0')).status).toBe(422)
    expect((await find(s, 'funding', '&limit=21')).status).toBe(422)
    expect((await find(s, 'funding', '&limit=abc')).status).toBe(422)
  })

  it('takes a query of the longest allowed length', async () => {
    const s = await setup()
    const q = 'funding '.repeat(25).trim() // 199 characters
    expect(q.length).toBeLessThanOrEqual(200)
    expect((await find(s, q)).status).toBe(200)
  })
})

describe('the database narrowing never changes the answer', () => {
  // The service asks Postgres for candidate sentences and scores only those. The algorithm itself is unchanged, so
  // for any query the result must equal scoring every sentence in memory. If narrowing ever dropped a real match,
  // this is where it shows.
  const QUERIES = [
    'funding',
    'फंडिंग',
    'phunding',
    'fundding',
    'where I talk about funding',
    'funding wala hissa',
    'investor',
    'investors',
    'इन्वेस्टर्स',
    'investar',
    'paisa',
    'पैसा',
    'raise',
    'raisse',
    'रेज़',
    'galti',
    'गलती',
    'mistake',
    'where I talk about my mistake',
    'lakh',
    'khrch',
    'kharch',
    'term sheet',
    'टर्म शीट',
    'lawyer',
    'clause',
    'pitch deck',
    'पिच डेक',
    'slides',
    'traction',
    'hiring',
    'hire',
    'हायरिंग',
    'culture',
    'bootstrapping',
    'bootstraping',
    'बूटस्ट्रैपिंग',
    'cash flow',
    'payroll',
    'पेरोल',
    'darr',
    'डर',
    'reels',
    'instagram',
    'brand',
    'visibility',
    'valuation',
    'kahani',
    'story',
    'number',
    'product',
    'retention',
    'founder',
    'salah',
    'advice',
    'funding aur galti',
    'funding investor pitch',
    'zzxqv',
    'raha',
    'sawaal',
    'सवाल',
    'matlab',
    'basically',
  ]

  it('gives exactly the in-memory result for every query', async () => {
    const s = await setup()
    let withResults = 0
    for (const q of QUERIES) {
      const got = (await find(s, q)).body
      expect(got, `query ${JSON.stringify(q)}`).toEqual(expected(s, q))
      if (got.length) withResults++
    }
    expect(withResults).toBeGreaterThan(40)
  })

  it('and for different limits', async () => {
    const s = await setup()
    for (const limit of [1, 2, 3, 5, 20]) {
      expect((await find(s, 'funding', `&limit=${limit}`)).body).toEqual(
        expected(s, 'funding', limit),
      )
    }
  })
})

describe('hostile queries', () => {
  const nasty = [
    "'; DROP TABLE transcript_sentences; --",
    "funding' OR '1'='1",
    '") OR 1=1 --',
    '%',
    '_',
    '\\',
    'a_b%c',
    '100%',
    '\\%',
    'funding:*',
    'funding & investor',
    'funding | !galti',
    '(((',
    ')))',
    '<->',
    "'",
    '"',
    '\u0000',
    'fun\u0000ding',
    '😀 funding 😀',
    'ＦＵＮＤＩＮＧ',
    'fünding',
    'ŕaise',
    'फंडिंग‍',
    'ਫੰਡਿੰਗ',
    'مرحبا',
    '日本語',
    'a'.repeat(200),
  ]

  it('are answered, never crash, and never touch the data', async () => {
    const s = await setup()
    for (const q of nasty) {
      const res = await find(s, q)
      expect(res.status, JSON.stringify(q)).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    }
    // The table is still there and the normal search still works.
    expect((await find(s, 'funding')).body.length).toBeGreaterThan(1)
  })

  it('wildcards in a query are plain text, so "%" does not match everything', async () => {
    const s = await setup()
    expect((await find(s, '%%%')).body).toEqual([])
    expect((await find(s, '_ _ _')).body).toEqual([])
  })

  it('a query one character over the limit is refused', async () => {
    const s = await setup()
    expect((await find(s, 'a'.repeat(201))).status).toBe(422)
  })

  it('hostile queries give what their letters give, nothing more', async () => {
    const s = await setup()
    expect((await find(s, "funding'; DROP TABLE x; --")).body).toEqual(
      expected(s, "funding'; DROP TABLE x; --"),
    )
  })
})

describe('a long recording', () => {
  it('searches an hour-and-a-half transcript quickly and bounds its own work', async () => {
    // 18 lines repeated 400 times: about 7,200 sentences and 80,000 words.
    const lines: typeof LINES = []
    for (let i = 0; i < 400; i++) lines.push(...LINES)
    const s = await setup(lines)
    expect(s.content!.transcript.words.length).toBeGreaterThan(70_000)

    const timed = async (q: string) => {
      const started = Date.now()
      const res = await find(s, q)
      return { ms: Date.now() - started, res }
    }
    await timed('funding') // warm up
    for (const q of ['funding', 'फंडिंग', 'where I talk about my mistake', 'term sheet', 'zzxqv']) {
      const { ms, res } = await timed(q)
      expect(res.status, q).toBe(200)
      expect(res.body.length, q).toBeLessThanOrEqual(8)
      expect(ms, `${q} took ${ms} ms`).toBeLessThan(1500)
    }
  }, 120_000)
})
