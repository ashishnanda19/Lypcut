import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { llmUsage } from '../../src/db/schema/index.js'
import { FakeProvider } from '../../src/llm/fake.js'
import { Llm, type LlmDeps } from '../../src/llm/service.js'
import { LlmError, type GenerateRequest, type LlmProvider } from '../../src/llm/types.js'
import { plannerRequestsSince, spendThisMonth } from '../../src/llm/usage.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { signup } from '../helpers/world.js'
import { readyProject } from '../helpers/ready.js'

let t: TestApp
let userId: string
let projectId: string
beforeAll(async () => {
  t = await createTestApp()
  await t.app.ready()
  const me = await signup(t)
  userId = me.id
  projectId = (await readyProject(t, me)).projectId
})
afterAll(() => t.close())
beforeEach(async () => {
  await t.deps.database.db.delete(llmUsage)
})

const SECRET = 'my-secret-prompt-about-funding'
const req = (purpose: GenerateRequest['purpose'] = 'planner'): GenerateRequest => ({
  purpose,
  system: 'static instructions',
  context: '{"sentences":[]}',
  messages: [{ role: 'user', content: SECRET }],
  maxOutputTokens: 500,
})

/** A real-looking provider the test controls. */
function scripted(name = 'anthropic') {
  const calls: GenerateRequest[] = []
  let behave: (n: number) => Promise<void> | void = () => undefined
  const p: LlmProvider = {
    name,
    async generate(r) {
      calls.push(r)
      await behave(calls.length)
      return {
        text: 'hello',
        extraToolCalls: 0,
        stop: 'end',
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 },
        model: r.purpose === 'planner' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5',
      }
    },
  }
  return { p, calls, set: (f: typeof behave) => void (behave = f) }
}

function build(over: Partial<LlmDeps> & { primary?: LlmDeps['primary'] } = {}) {
  const lines: string[] = []
  const log = pino(
    { level: 'debug' },
    new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }),
  )
  const planner = scripted()
  const batch = scripted()
  const llm = new Llm({
    config: {
      LLM_MAX_INPUT_TOKENS: 60_000,
      LLM_MAX_RETRIES: 2,
      LLM_RETRY_BASE_MS: 1,
      LLM_MONTHLY_BUDGET_USD: 0,
      LLM_BREAKER_FAILURES: 3,
      LLM_BREAKER_COOLDOWN_SEC: 60,
    },
    db: t.deps.database.db,
    log,
    primary: { planner: planner.p, batch: batch.p },
    fake: new FakeProvider({ planner: () => ({ text: 'offline answer' }) }),
    sleep: async () => undefined,
    random: () => 0,
    ...over,
  })
  return { llm, planner, batch, lines }
}

const rows = () => t.deps.database.db.select().from(llmUsage).where(eq(llmUsage.userId, userId))

describe('which model answers', () => {
  it('uses the planner model for chat and the batch model for highlights and chapters', async () => {
    const { llm, planner, batch } = build()
    await llm.generate(req('planner'), { userId })
    await llm.generate(req('highlights'), { userId })
    await llm.generate(req('chapters'), { userId })
    expect(planner.calls).toHaveLength(1)
    expect(batch.calls).toHaveLength(2)
  })

  it('runs everything on the offline model when no real model is configured', async () => {
    const { llm } = build({ primary: null })
    const r = await llm.generate(req(), { userId })
    expect(r).toMatchObject({ provider: 'fake', degraded: false, text: 'offline answer' })
    expect(llm.hasRealModel).toBe(false)
  })
})

describe('recording usage', () => {
  it('writes one row per call with tokens, an estimated cost, the model and the outcome', async () => {
    const { llm } = build()
    await llm.generate(req('planner'), { userId, projectId })
    const [row] = await rows()
    expect(row).toMatchObject({
      userId,
      projectId,
      kind: 'planner',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      outcome: 'ok',
      degraded: false,
    })
    // 1000 in at $2/M + 100 out at $10/M + 500 cached at $0.2/M
    expect(row!.costUsd).toBeCloseTo(0.002 + 0.001 + 0.0001, 6)
  })

  it('costs the offline model nothing', async () => {
    const { llm } = build({ primary: null })
    await llm.generate(req(), { userId })
    expect((await rows())[0]!.costUsd).toBe(0)
  })

  it('records a failure with no tokens and its kind', async () => {
    const { llm, planner } = build()
    planner.set(() => {
      throw new LlmError('unauthorized', 'bad key')
    })
    await expect(llm.generate(req(), { userId })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect((await rows())[0]).toMatchObject({ outcome: 'unauthorized', inputTokens: 0, costUsd: 0 })
  })

  it('records a refusal as refused and still returns it', async () => {
    const { llm, planner } = build()
    const real = planner.p.generate.bind(planner.p)
    planner.p.generate = async (r, s) => ({ ...(await real(r, s)), stop: 'refusal' as const })
    expect((await llm.generate(req(), { userId })).stop).toBe('refusal')
    expect((await rows())[0]!.outcome).toBe('refused')
  })

  it('a bookkeeping failure never turns a good answer into an error', async () => {
    const { llm } = build()
    // A user id that does not exist violates the foreign key, so the row cannot be written.
    const r = await llm.generate(req(), { userId: '00000000-0000-7000-8000-000000000000' })
    expect(r.text).toBe('hello')
  })

  it('sums this month’s spend and counts a person’s planner requests, leaving out fallback answers', async () => {
    const { llm } = build()
    await llm.generate(req('planner'), { userId })
    await llm.generate(req('planner'), { userId })
    await llm.generate(req('highlights'), { userId })
    expect(
      await plannerRequestsSince(t.deps.database.db, userId, new Date(Date.now() - 86_400_000)),
    ).toBe(2)
    expect(await spendThisMonth(t.deps.database.db)).toBeGreaterThan(0)
    await t.deps.database.db
      .update(llmUsage)
      .set({ degraded: true })
      .where(eq(llmUsage.kind, 'planner'))
    expect(
      await plannerRequestsSince(t.deps.database.db, userId, new Date(Date.now() - 86_400_000)),
    ).toBe(0)
  })
})

describe('retries', () => {
  it('retries a rate limit and succeeds, and the usage row is for the call that worked', async () => {
    const { llm, planner } = build()
    planner.set((n) => {
      if (n < 3) throw new LlmError('rate_limited', 'slow')
    })
    const r = await llm.generate(req(), { userId })
    expect(r.text).toBe('hello')
    expect(planner.calls).toHaveLength(3)
    expect(await rows()).toHaveLength(1)
  })

  it('gives up after the configured retries', async () => {
    const { llm, planner } = build()
    planner.set(() => {
      throw new LlmError('server', 'down')
    })
    await expect(llm.generate(req(), { userId })).rejects.toMatchObject({ kind: 'server' })
    expect(planner.calls).toHaveLength(3)
  })
})

describe('refusing what is too big', () => {
  it('turns away an enormous request before any model sees it', async () => {
    const { llm, planner } = build()
    const big = { ...req(), context: 'x'.repeat(300_000) }
    await expect(llm.generate(big, { userId })).rejects.toMatchObject({ kind: 'too_large' })
    expect(planner.calls).toHaveLength(0)
  })
})

describe('the monthly budget', () => {
  it('hands over to the offline model once the month’s spend reaches the ceiling, and says so', async () => {
    const { llm, planner } = build({
      config: {
        LLM_MAX_INPUT_TOKENS: 60_000,
        LLM_MAX_RETRIES: 0,
        LLM_RETRY_BASE_MS: 1,
        LLM_MONTHLY_BUDGET_USD: 0.001,
        LLM_BREAKER_FAILURES: 3,
        LLM_BREAKER_COOLDOWN_SEC: 60,
      },
    })
    const first = await llm.generate(req(), { userId })
    expect(first).toMatchObject({ provider: 'anthropic', degraded: false })
    const second = await llm.generate(req(), { userId })
    expect(second).toMatchObject({ provider: 'fake', degraded: true, text: 'offline answer' })
    expect(planner.calls).toHaveLength(1)
    const all = await rows()
    expect(all.map((r) => r.degraded)).toEqual([false, true])
  })

  it('no ceiling means no limit', async () => {
    const { llm, planner } = build()
    for (let i = 0; i < 5; i++) await llm.generate(req(), { userId })
    expect(planner.calls).toHaveLength(5)
  })
})

describe('the circuit breaker', () => {
  it('after repeated failures the offline model answers, without errors for the user', async () => {
    const { llm, planner } = build({
      config: {
        LLM_MAX_INPUT_TOKENS: 60_000,
        LLM_MAX_RETRIES: 0,
        LLM_RETRY_BASE_MS: 1,
        LLM_MONTHLY_BUDGET_USD: 0,
        LLM_BREAKER_FAILURES: 3,
        LLM_BREAKER_COOLDOWN_SEC: 60,
      },
    })
    planner.set(() => {
      throw new LlmError('server', 'down')
    })
    for (let i = 0; i < 3; i++)
      await expect(llm.generate(req(), { userId })).rejects.toBeInstanceOf(LlmError)
    const r = await llm.generate(req(), { userId })
    expect(r).toMatchObject({ provider: 'fake', degraded: true })
    expect(planner.calls).toHaveLength(3)
  })

  it('a refusal or a too-large request is not the service failing, so it does not trip the breaker', async () => {
    const { llm, planner } = build()
    const big = { ...req(), context: 'x'.repeat(300_000) }
    for (let i = 0; i < 5; i++) await llm.generate(big, { userId }).catch(() => undefined)
    expect((await llm.generate(req(), { userId })).provider).toBe('anthropic')
    expect(planner.calls).toHaveLength(1)
  })
})

describe('what the logs hold', () => {
  it('ids, token counts, latency and outcome, and never the prompt, the data or the reply', async () => {
    const { llm, lines } = build()
    await llm.generate(req(), { userId, projectId })
    const text = lines.join('')
    expect(text).toContain('model call')
    expect(text).toContain(projectId)
    expect(text).toMatch(/"inputTokens":1000/)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('static instructions')
    expect(text).not.toContain('"sentences"')
    expect(text).not.toContain('hello')
  })

  it('a failure logs its kind, not the prompt', async () => {
    const { llm, planner, lines } = build()
    planner.set(() => {
      throw new LlmError('bad_request', `rejected: ${SECRET}`)
    })
    await llm.generate(req(), { userId }).catch(() => undefined)
    // The error's own message may mention what it likes; the log line carries only the kind.
    expect(lines.join('')).toContain('bad_request')
    expect(lines.join('')).not.toContain(SECRET)
  })
})
