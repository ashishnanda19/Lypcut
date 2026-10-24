import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasModel, TransformersEmbeddingProvider } from '../../src/llm/transformers-embedding.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { seedEmbeddings } from '../helpers/embeddings.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { LINES } from '../helpers/transcript-fixture.js'
import { signup, type Person } from '../helpers/world.js'

/**
 * Search with the real multilingual model, for what a stand-in cannot show: that a Hindi sentence is found by an English
 * description of it, and the speed with the model in the loop. It runs when the model has been downloaded
 * (`npm run models:download-embeddings`) and is skipped otherwise.
 */
const DIR = './models/embeddings'
const MODEL = 'Xenova/multilingual-e5-small'
const have = hasModel(DIR, MODEL)

let t: TestApp
let provider: TransformersEmbeddingProvider
beforeAll(async () => {
  if (!have) return
  t = await createTestApp()
  provider = new TransformersEmbeddingProvider({ model: MODEL, dir: DIR })
  await provider.warm()
})
afterAll(async () => {
  if (have) await t.close()
})

type Setup = Person & ReadyProject
async function setup(lines: typeof LINES = LINES): Promise<Setup> {
  await resetDatabase(t.deps.database)
  const person = await signup(t)
  const s = { ...person, ...(await readyProject(t, person, { content: lines })) } as Setup
  t.deps.embeddings = provider
  await seedEmbeddings(t, s.projectId, provider)
  return s
}
const find = (s: Setup, q: string) =>
  s.c.get(`/api/projects/${s.projectId}/search?q=${encodeURIComponent(q)}`)
const said = (s: Setup, r: { from: number; to: number }) =>
  s
    .content!.transcript.words.slice(r.from, r.to)
    .map((w) => w.dev || w.text)
    .join(' ')

describe.skipIf(!have)('search by meaning with the real model', () => {
  it('finds a Hindi sentence from an English description of it', async () => {
    const s = await setup()
    const res = await find(s, 'the worst financial mistake I made')
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    expect(said(s, res.body[0])).toMatch(/गलती/)
  })

  it('finds an English-leaning sentence from a Hinglish question', async () => {
    const s = await setup()
    const res = await find(s, 'term sheet par kya dekhna chahiye')
    expect(said(s, res.body[0])).toMatch(/टर्म|क्लॉज़|लॉयर/)
  })

  it('finds the same moment from a Devanagari and a Roman query', async () => {
    const s = await setup()
    const roman = await find(s, 'hiring ke baare mein')
    const dev = await find(s, 'हायरिंग के बारे में')
    expect(said(s, roman.body[0])).toMatch(/हायर/)
    expect(said(s, dev.body[0])).toMatch(/हायर/)
  })

  it('searches a 10-minute video in under 400 ms at the 95th percentile, the query embedding included', async () => {
    const lines = Array.from({ length: 130 }, (_, i) => LINES[i % LINES.length]!)
    const s = await setup(lines)
    const queries = [
      'kya galti hui',
      'funding ke liye investors',
      'how to hire',
      'term sheet',
      'payroll ka darr',
      'reels aur instagram',
      'valuation kya hai',
      'cash flow',
    ]
    await find(s, 'warm up')
    const times: number[] = []
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now()
      const res = await find(s, `${queries[i % queries.length]} ${i}`)
      times.push(performance.now() - t0)
      expect(res.status).toBe(200)
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95)]!
    expect(p95, `p95 ${p95.toFixed(0)} ms`).toBeLessThan(400)
  })
})
