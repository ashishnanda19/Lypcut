import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { editPlans, llmUsage } from '../../src/db/schema/index.js'
import { FakeProvider } from '../../src/llm/fake.js'
import { Llm } from '../../src/llm/service.js'
import { LlmError, type GenerateResult, type LlmProvider } from '../../src/llm/types.js'
import { fakePlanner } from '../../src/planner/fake.js'
import { plannerResultSchema } from '../../src/planner/types.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
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
async function setup(plan?: 'free' | 'creator' | 'studio'): Promise<Setup> {
  const person = await signup(t, plan)
  return { ...person, ...(await readyProject(t, person, { content: true, fitTimeline: true })) }
}

const body = (over: Record<string, unknown> = {}) => ({
  playhead: 0,
  applyStyle: false,
  history: [],
  ...over,
})
const ask = (s: Setup, text: string, over: Record<string, unknown> = {}) =>
  s.c.post(`/api/projects/${s.projectId}/assistant/messages`, body({ text, ...over }))
const apply = (s: Setup, planId: string, baseVersion: number) =>
  s.c.post(`/api/projects/${s.projectId}/plans/${planId}/apply`, { baseVersion })
const usageOf = async (s: Setup) => (await s.c.get('/api/me/usage')).body

/** Puts `n` counted assistant requests on a person's record, `agoSec` seconds old. */
async function seedRequests(userId: string, n: number, agoSec = 0, outcome = 'ok') {
  const at = new Date(Date.now() - agoSec * 1000)
  await t.deps.database.db.insert(llmUsage).values(
    Array.from({ length: n }, (_, i) => ({
      userId,
      kind: 'planner' as const,
      requestId: `seed-${userId}-${agoSec}-${i}-${outcome}`,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      outcome,
      createdAt: at,
    })),
  )
}

describe('POST /assistant/messages', () => {
  it('returns a result that matches the contract, with a plan the person can apply', async () => {
    const s = await setup()
    const res = await ask(s, 'filler words hatao')
    expect(res.status).toBe(200)
    expect(() => plannerResultSchema.parse(res.body)).not.toThrow()
    expect(res.body.plan.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('needs a login, and keeps messages short', async () => {
    const s = await setup()
    const anon = await t.app.inject({
      method: 'POST',
      url: `/api/projects/${s.projectId}/assistant/messages`,
      payload: body({ text: 'hi' }),
    })
    expect(anon.statusCode).toBe(401)
    const long = await ask(s, 'a'.repeat(1001))
    expect(long.status).toBe(422)
  })

  it('refuses a project that is not ready or not theirs', async () => {
    const s = await setup()
    const other = await setup()
    const res = await other.c.post(
      `/api/projects/${s.projectId}/assistant/messages`,
      body({ text: 'filler words hatao' }),
    )
    expect(res.status).toBe(404)
  })
})

describe('applying a plan', () => {
  it('makes an assistant version carrying the plan’s id, and the plan then reads as applied', async () => {
    const s = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    const listed = await s.c.get(`/api/projects/${s.projectId}/plans`)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0]).toMatchObject({ id: plan.id, status: 'proposed' })

    const res = await apply(s, plan.id, 0)
    expect(res.status).toBe(200)
    expect(res.body.version).toMatchObject({ n: 1, author: 'ai', editId: plan.id })
    expect(res.body.state.version).toBe(1)

    const after = await s.c.get(`/api/projects/${s.projectId}/plans`)
    expect(after.body[0].status).toBe('applied')
    const [row] = await t.deps.database.db.select().from(editPlans).where(eq(editPlans.id, plan.id))
    expect(row).toMatchObject({ status: 'applied', appliedVersion: 1 })
  })

  it('cannot be applied twice', async () => {
    const s = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    expect((await apply(s, plan.id, 0)).status).toBe(200)
    const again = await apply(s, plan.id, 1)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('CONFLICT')
  })

  it('undoing the version makes the plan undone, and redoing it makes it applied again', async () => {
    const s = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    await apply(s, plan.id, 0)
    const status = async () => (await s.c.get(`/api/projects/${s.projectId}/plans`)).body[0].status

    expect(
      (await s.c.post(`/api/projects/${s.projectId}/timeline/undo`, { baseVersion: 1 })).status,
    ).toBe(200)
    expect(await status()).toBe('undone')
    expect(
      (await s.c.post(`/api/projects/${s.projectId}/timeline/redo`, { baseVersion: 0 })).status,
    ).toBe(200)
    expect(await status()).toBe('applied')
  })

  it('committing a version that undoes the plan’s edit marks it undone', async () => {
    const s = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    await apply(s, plan.id, 0)
    const res = await s.c.post(`/api/projects/${s.projectId}/timeline/ops`, {
      baseVersion: 1,
      label: 'Undid: 3 filler words hatao',
      author: 'ai',
      undoesEditId: plan.id,
      ops: [{ type: 'addMarker', marker: { id: 'm1', time: 5, label: 'x' } }],
    })
    expect(res.status).toBe(200)
    const [row] = await t.deps.database.db.select().from(editPlans).where(eq(editPlans.id, plan.id))
    expect(row).toMatchObject({ status: 'undone', undoneByVersion: 2 })
  })

  it('a plan the timeline has moved past is applied if it still fits, with the person’s own version number', async () => {
    const s = await setup()
    const captions = (await ask(s, 'captions lagao')).body.plan
    const fillers = (await ask(s, 'filler words hatao')).body.plan
    expect((await apply(s, fillers.id, 0)).status).toBe(200)
    // The captions plan was made at version 0; the timeline is at 1 now, and the captions still fit.
    const res = await apply(s, captions.id, 1)
    expect(res.status).toBe(200)
    expect(res.body.version).toMatchObject({ n: 2, author: 'ai', editId: captions.id })
  })

  it('a plan the timeline has moved past and no longer fits is 409 STALE_PLAN, and nothing changes', async () => {
    const s = await setup()
    // Two zooms at the same place: once one is on the timeline, the other would overlap it.
    const first = (await ask(s, 'zoom lagao', { playhead: 12 })).body.plan
    const second = (await ask(s, 'zoom lagao', { playhead: 12 })).body.plan
    expect((await apply(s, second.id, 0)).status).toBe(200)
    const res = await apply(s, first.id, 1)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STALE_PLAN')
    expect(res.body.error.details).toMatchObject({ planVersion: 0, currentVersion: 1 })
    expect((await s.c.get(`/api/projects/${s.projectId}/timeline`)).body.version).toBe(1)
    const rows = await t.deps.database.db.select().from(editPlans)
    expect(rows.find((r) => r.id === first.id)?.status).toBe('proposed')
  })

  it('an out-of-date baseVersion is the usual VERSION_CONFLICT, not a stale plan', async () => {
    const s = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    const res = await apply(s, plan.id, 7)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
  })

  it('does not find another person’s plan', async () => {
    const s = await setup()
    const other = await setup()
    const plan = (await ask(s, 'filler words hatao')).body.plan
    const res = await other.c.post(`/api/projects/${other.projectId}/plans/${plan.id}/apply`, {
      baseVersion: 0,
    })
    expect(res.status).toBe(404)
  })
})

describe('the Reel button', () => {
  it('builds a plan from a range without using the allowance', async () => {
    const s = await setup()
    const res = await s.c.post(
      `/api/projects/${s.projectId}/assistant/reel`,
      body({ srcFrom: 10, srcTo: 40, title: 'Funding', hookScore: 82 }),
    )
    expect(res.status).toBe(200)
    expect(res.body.plan.title).toMatch(/Funding/)
    expect((await usageOf(s)).planner.used).toBe(0)
  })
})

describe('GET /me/usage and the limits', () => {
  it('reports the plan and today’s allowance, scaled by the plan', async () => {
    const free = await setup()
    const creator = await setup('creator')
    const f = await usageOf(free)
    expect(f).toMatchObject({ plan: 'free', planner: { used: 0, limit: 30 } })
    expect(new Date(f.planner.resetsAt).getTime()).toBeGreaterThan(Date.now())
    expect(new Date(f.planner.resetsAt).getUTCHours()).toBe(0)
    expect((await usageOf(creator)).planner.limit).toBe(150)
  })

  it('counts a request once, however it is counted, and not the ones that need no model', async () => {
    const s = await setup()
    await seedRequests(s.id, 2, 3600)
    expect((await usageOf(s)).planner.used).toBe(2)
    // Music is answered without a model.
    await ask(s, 'add some background music')
    expect((await usageOf(s)).planner.used).toBe(2)
  })

  it('refuses with 429, Retry-After and the numbers when the day’s allowance is used', async () => {
    const s = await setup()
    await seedRequests(s.id, 30, 3 * 60)
    const res = await ask(s, 'filler words hatao')
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('RATE_LIMITED')
    expect(res.body.error.details).toMatchObject({ limit: 30, used: 30 })
    const retry = Number(res.headers['retry-after'])
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(24 * 3600)
    expect(JSON.stringify(res.body)).not.toMatch(/filler/)
  })

  it('refuses a burst, and says to wait until the oldest request is a minute old', async () => {
    const s = await setup()
    await seedRequests(s.id, 10, 20)
    const res = await ask(s, 'filler words hatao')
    expect(res.status).toBe(429)
    expect(res.body.error.details).toMatchObject({ limit: 10, window: 'minute' })
    const retry = Number(res.headers['retry-after'])
    expect(retry).toBeGreaterThan(30)
    expect(retry).toBeLessThanOrEqual(41)
  })

  it('lets requests through again when they are older than a minute, and lets a larger plan do more', async () => {
    const s = await setup()
    await seedRequests(s.id, 10, 90)
    expect((await ask(s, 'filler words hatao')).status).toBe(200)

    const creator = await setup('creator')
    await seedRequests(creator.id, 30, 3 * 60)
    expect((await ask(creator, 'filler words hatao')).status).toBe(200)
  })

  it('the offline model costs nothing, so it never uses up the allowance', async () => {
    const s = await setup()
    for (let i = 0; i < 12; i++) expect((await ask(s, 'filler words hatao')).status).toBe(200)
    expect((await usageOf(s)).planner.used).toBe(0)
  })

  it('a failed model call does not use up the allowance', async () => {
    const s = await setup()
    await seedRequests(s.id, 29, 3 * 60)
    await seedRequests(s.id, 5, 3 * 60, 'timeout')
    await seedRequests(s.id, 5, 3 * 60, 'overloaded')
    expect((await usageOf(s)).planner.used).toBe(29)
    expect((await ask(s, 'filler words hatao')).status).toBe(200)
  })

  it('limits are per person', async () => {
    const a = await setup()
    const b = await setup()
    await seedRequests(a.id, 30, 3 * 60)
    expect((await ask(a, 'filler words hatao')).status).toBe(429)
    expect((await ask(b, 'filler words hatao')).status).toBe(200)
  })
})

describe('with a model that answers', () => {
  const usage = { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const answer: GenerateResult = {
    text: 'Okay.',
    extraToolCalls: 0,
    stop: 'end',
    usage,
    model: 'claude-sonnet-5-5',
    latencyMs: 5,
  }

  function withProvider(provider: LlmProvider) {
    const original = t.deps.llm
    t.deps.llm = new Llm({
      config: {
        LLM_MAX_INPUT_TOKENS: 60_000,
        LLM_MAX_RETRIES: 0,
        LLM_RETRY_BASE_MS: 1,
        LLM_MONTHLY_BUDGET_USD: 0,
        LLM_BREAKER_FAILURES: 99,
        LLM_BREAKER_COOLDOWN_SEC: 60,
      },
      db: t.deps.database.db,
      log: pino({ level: 'silent' }),
      primary: { planner: provider, batch: provider },
      fake: new FakeProvider({ planner: fakePlanner }),
      sleep: async () => undefined,
    })
    return () => {
      t.deps.llm = original
    }
  }

  it('counts a request that reached the model, and not one the service failed', async () => {
    const s = await setup()
    const restore = withProvider({ name: 'anthropic', generate: async () => answer })
    try {
      // Not understood by the rules, so the model is asked.
      expect((await ask(s, 'what is the vibe of this video?')).status).toBe(200)
      expect((await usageOf(s)).planner.used).toBe(1)
    } finally {
      restore()
    }

    const down = withProvider({
      name: 'anthropic',
      generate: async () => {
        throw new LlmError('timeout', 'timed out')
      },
    })
    try {
      const res = await ask(s, 'what is the vibe of this video?')
      expect(res.status).toBe(200)
      expect(res.body.plan).toBeUndefined()
      expect((await usageOf(s)).planner.used).toBe(1)
    } finally {
      down()
    }
  })
})
