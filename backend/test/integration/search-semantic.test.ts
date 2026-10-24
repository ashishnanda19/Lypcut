import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sentenceEmbeddings, transcriptSentences } from '../../src/db/schema/index.js'
import { FakeEmbeddingProvider } from '../../src/llm/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { seedEmbeddings, TopicEmbeddings } from '../helpers/embeddings.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { LINES } from '../helpers/transcript-fixture.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
const original = () => t.deps.embeddings
let realEmbeddings: typeof t.deps.embeddings

beforeAll(async () => {
  t = await createTestApp()
  realEmbeddings = original()
})
afterAll(async () => {
  t.deps.embeddings = realEmbeddings
  await t.close()
})
beforeEach(async () => {
  t.deps.embeddings = realEmbeddings
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

/** Meaning, as these tests define it: money, hiring, mistakes and legal paperwork. Roman and Devanagari alike. */
const topics = () =>
  new TopicEmbeddings({
    money: [
      'funding',
      'फंडिंग',
      'investor',
      'इन्वेस्टर',
      'पैसा',
      'paisa',
      'रेज़',
      'capital',
      'करोड़',
      'valuation',
      'वैल्यूएशन',
      'raising money',
    ],
    hiring: ['हायरिंग', 'हायर', 'hiring', 'hire', 'recruit', 'staffing'],
    mistake: ['गलती', 'mistake', 'galti', 'blunder'],
    legal: ['टर्म', 'term sheet', 'लॉयर', 'lawyer', 'clause', 'contract'],
  })

type Setup = Person & ReadyProject
async function setup(): Promise<Setup> {
  const person = await signup(t)
  return { ...person, ...(await readyProject(t, person, { content: true })) }
}
const find = (s: Setup, q: string, extra = '') =>
  s.c.get(`/api/projects/${s.projectId}/search?q=${encodeURIComponent(q)}${extra}`)

const wordsOf = (s: Setup, r: { from: number; to: number }) =>
  s
    .content!.transcript.words.slice(r.from, r.to)
    .map((w) => `${w.text} ${w.dev}`)
    .join(' ')

describe('search by meaning', () => {
  it('finds a moment by what it is about, with none of its words in the query', async () => {
    const s = await setup()
    // "staffing" is in no synonym group and nowhere in the transcript, so words alone find nothing.
    expect((await find(s, 'staffing')).body).toEqual([])
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    const res = await find(s, 'staffing')
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    expect(wordsOf(s, res.body[0])).toMatch(/हायरिंग/)
  })

  it('a hit found by meaning alone has no matched words, and is a whole window of sentences', async () => {
    const s = await setup()
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    const res = await find(s, 'staffing')
    const top = res.body[0]
    expect(top.matched).toEqual([])
    // from/to are the word range of whole sentences.
    const sentences = s.content!.transcript.sentences
    expect(sentences.some((x) => x.from === top.from)).toBe(true)
    expect(sentences.some((x) => x.to === top.to)).toBe(true)
    expect(top.relevance).toBeGreaterThanOrEqual(40)
    expect(top.relevance).toBeLessThanOrEqual(85)
  })

  it('merges with the words: a moment found both ways keeps its matched words and scores at least as high', async () => {
    const s = await setup()
    const lexicalAlone = await find(s, 'funding')
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    const both = await find(s, 'funding')
    expect(both.status).toBe(200)
    expect(both.body[0].matched.length).toBeGreaterThan(0)
    expect(both.body[0].relevance).toBeGreaterThanOrEqual(lexicalAlone.body[0].relevance)
    // Everything the words found is still found.
    for (const r of lexicalAlone.body.slice(0, 3)) {
      expect(
        both.body.some((b: { start: number; end: number }) => b.start < r.end && b.end > r.start),
      ).toBe(true)
    }
  })

  it('brings in related moments the words alone miss, below the exact matches', async () => {
    const s = await setup()
    const alone = await find(s, 'funding')
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    const both = await find(s, 'funding')
    expect(both.body.length).toBeGreaterThanOrEqual(alone.body.length)
    const semanticOnly = both.body.filter((r: { matched: number[] }) => r.matched.length === 0)
    const exact = both.body.filter((r: { matched: number[] }) => r.matched.length > 0)
    expect(exact.length).toBeGreaterThan(0)
    for (const r of semanticOnly) expect(r.relevance).toBeLessThanOrEqual(exact[0].relevance)
  })

  it('never returns overlapping clips, orders by relevance, and respects the limit', async () => {
    const s = await setup()
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    for (const q of ['funding', 'staffing', 'blunder', 'contract']) {
      const res = await find(s, q, '&limit=3')
      expect(res.body.length).toBeLessThanOrEqual(3)
      const scores = res.body.map((r: { relevance: number }) => r.relevance)
      expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a))
      for (const a of res.body)
        for (const b of res.body)
          if (a !== b) expect(a.start < b.end && a.end > b.start, q).toBe(false)
    }
  })

  it('a Roman and a Devanagari query about the same thing find the same moment', async () => {
    const s = await setup()
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    const roman = await find(s, 'funding')
    const dev = await find(s, 'फंडिंग')
    expect(dev.body[0].start).toBe(roman.body[0].start)
    expect(dev.body[0].end).toBe(roman.body[0].end)
  })

  it('answers nothing for a query about nothing in the video', async () => {
    const s = await setup()
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    // About no topic at all: its vector points at no window's topic, so nothing is close in meaning.
    expect((await find(s, 'quantum chromodynamics')).body).toEqual([])
  })
})

describe('when meaning is unavailable', () => {
  it('gives exactly what the words give when no vectors were stored', async () => {
    const s = await setup()
    const alone = await find(s, 'funding')
    t.deps.embeddings = topics()
    const withProviderButNoVectors = await find(s, 'funding')
    expect(withProviderButNoVectors.status).toBe(200)
    expect(withProviderButNoVectors.body).toEqual(alone.body)
  })

  it('gives exactly what the words give when the embedding service fails, and no error', async () => {
    const s = await setup()
    const alone = await find(s, 'funding')
    const emb = topics()
    await seedEmbeddings(t, s.projectId, emb)
    emb.fail = new Error('the embedding service is down')
    t.deps.embeddings = emb
    const res = await find(s, 'funding')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(alone.body)
  })

  it('ignores vectors that another model made', async () => {
    const s = await setup()
    const other = topics()
    await seedEmbeddings(t, s.projectId, other)
    // A different model is now configured: the stored vectors are not comparable, so they are not used.
    t.deps.embeddings = topics()
    const res = await find(s, 'staffing')
    expect(res.body).toEqual([])
  })

  it('remembers a query’s vector, so asking again does not embed it again', async () => {
    const s = await setup()
    const emb = topics()
    t.deps.embeddings = emb
    await seedEmbeddings(t, s.projectId, emb)
    await find(s, 'staffing')
    await find(s, 'staffing')
    await find(s, 'Staffing ')
    expect(emb.queries).toEqual(['staffing'])
  })
})

describe('what is stored', () => {
  it('one vector per sentence, each window starting on a sentence and ending on one', async () => {
    const s = await setup()
    const { windows, transcriptId } = await seedEmbeddings(t, s.projectId, topics())
    const rows = await t.deps.database.db
      .select()
      .from(sentenceEmbeddings)
      .where(eq(sentenceEmbeddings.transcriptId, transcriptId))
    expect(rows).toHaveLength(LINES.length)
    expect(windows).toHaveLength(LINES.length)
    const sentenceRows = await t.deps.database.db
      .select()
      .from(transcriptSentences)
      .where(eq(transcriptSentences.transcriptId, transcriptId))
    const starts = new Set(sentenceRows.map((x) => x.startSec))
    const ends = new Set(sentenceRows.map((x) => x.endSec))
    for (const r of rows) {
      expect(starts.has(r.startSec)).toBe(true)
      expect(ends.has(r.endSec)).toBe(true)
      expect(r.embedding).toHaveLength(384)
    }
  })

  it('goes when the project goes, and when the account goes', async () => {
    const a = await setup()
    const b = await setup()
    await seedEmbeddings(t, a.projectId, topics())
    await seedEmbeddings(t, b.projectId, topics())
    const total = async () =>
      (await t.deps.database.db.select({ n: count() }).from(sentenceEmbeddings))[0]!.n
    expect(await total()).toBe(LINES.length * 2)
    expect((await a.c.del(`/api/projects/${a.projectId}`)).status).toBe(200)
    await t.deps.queues.close().catch(() => undefined)
    // The project's rows go with it (deleting is done by a worker for the files; the rows go at once).
    const left = await t.deps.database.db
      .select()
      .from(sentenceEmbeddings)
      .where(eq(sentenceEmbeddings.projectId, a.projectId))
    expect(left).toEqual([])
    expect(await total()).toBe(LINES.length)
  })

  it('is private: another person cannot search a project’s meaning', async () => {
    const a = await setup()
    const b = await setup()
    t.deps.embeddings = topics()
    await seedEmbeddings(t, a.projectId, t.deps.embeddings)
    expect((await b.c.get(`/api/projects/${a.projectId}/search?q=funding`)).status).toBe(404)
  })
})

describe('how fast it is', () => {
  it('searches a 10-minute video in well under 400 ms at the 95th percentile, query embedding included', async () => {
    const person = await signup(t)
    // 10 minutes of talk: about 130 sentences of 4-5 seconds.
    const lines = Array.from({ length: 130 }, (_, i) => LINES[i % LINES.length]!)
    const s = { ...person, ...(await readyProject(t, person, { content: lines })) } as Setup
    t.deps.embeddings = new FakeEmbeddingProvider()
    await seedEmbeddings(t, s.projectId, t.deps.embeddings)
    const queries = [
      'funding',
      'फंडिंग',
      'where I talk about my mistake',
      'investors ko pitch',
      'hiring',
      'valuation',
      'bootstrapping',
      'payroll darr',
    ]
    await find(s, 'warm up')
    const times: number[] = []
    for (let i = 0; i < 80; i++) {
      // A query typed afresh each time (the cache would make a repeat free), so the embedding is part of the time.
      const q = `${queries[i % queries.length]} ${i}`
      const t0 = performance.now()
      const res = await find(s, q)
      times.push(performance.now() - t0)
      expect(res.status).toBe(200)
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)]!
    expect(p95, `p95 ${p95.toFixed(0)} ms`).toBeLessThan(400)
  })
})
