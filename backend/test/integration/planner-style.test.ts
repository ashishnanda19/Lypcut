import { eq } from 'drizzle-orm'
import pino from 'pino'
import { applyOp, type TimelineOp } from '@lypcut/timeline-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { editPlans, instagramAccounts, styleProfiles } from '../../src/db/schema/index.js'
import { FakeProvider } from '../../src/llm/fake.js'
import { Llm } from '../../src/llm/service.js'
import type { GenerateRequest, LlmProvider } from '../../src/llm/types.js'
import { fakePlanner } from '../../src/planner/fake.js'
import { PlannerService } from '../../src/planner/service.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { LINES } from '../helpers/transcript-fixture.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
const log = pino({ level: 'silent' })
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
async function setup(): Promise<Setup> {
  const person = await signup(t)
  return { ...person, ...(await readyProject(t, person, { content: LINES, fitTimeline: true })) }
}

interface Profile {
  captionStyles?: Array<{ id: string; share: number }>
  cutPace?: number
  hookTimingSec?: number
  summary?: string
  confidence?: 'low' | 'medium' | 'high'
}
async function giveProfile(userId: string, p: Profile = {}) {
  await t.deps.database.db.insert(styleProfiles).values({
    userId,
    confidence: p.confidence ?? 'medium',
    profile: {
      reelsAnalysed: 8,
      captionStyles: p.captionStyles ?? [
        { id: 'karaoke', share: 0.7 },
        { id: 'boxed', share: 0.3 },
      ],
      cutPace: p.cutPace ?? 3,
      hookTimingSec: p.hookTimingSec ?? 1.5,
      music: [],
      hookRetention: [],
      fonts: ['Inter'],
      colors: [],
      confidence: p.confidence ?? 'medium',
      ...(p.summary ? { summary: p.summary } : {}),
    },
  })
}

const svc = (deps = t.deps) => new PlannerService(deps, log)
const common = (over: Record<string, unknown> = {}) => ({
  playhead: 0,
  applyStyle: false,
  history: [],
  ...over,
})
const say = (s: Setup, text: string, over: Record<string, unknown> = {}, service = svc()) =>
  service.message(s.id, s.projectId, { text, ...common(over) })

function flat(op: TimelineOp, out: TimelineOp[] = []): TimelineOp[] {
  out.push(op)
  if (op.type === 'batch') op.ops.forEach((o) => flat(o, out))
  return out
}
const styleOf = (op: TimelineOp) =>
  flat(op).find((o) => o.type === 'setCaptionStyle') as { styleId: string } | undefined
const cuts = (op: TimelineOp) => flat(op).filter((o) => o.type === 'cutSource')

describe('"match my style" with no profile yet', () => {
  it('says how to teach it, with a link to the Style page, and makes no plan', async () => {
    const s = await setup()
    for (const [prompt, pattern] of [
      ['match my style', /Connect Instagram, or upload three to five Reels/],
      ['meri style lagao', /Instagram connect karo, ya 3 se 5 Reels upload karo/],
      ['मेरी स्टाइल लगाओ', /Instagram कनेक्ट करें/],
    ] as const) {
      const r = await say(s, prompt)
      expect(r.plan, prompt).toBeUndefined()
      expect(r.text, prompt).toMatch(pattern)
      expect(r.route, prompt).toBe('/app/style')
    }
    expect(await t.deps.database.db.select().from(editPlans)).toEqual([])
  })
})

describe('"match my style" with a profile', () => {
  it('builds one valid plan of ordinary ops: a Reel from the opening that fits, pauses at their pace, captions in their look', async () => {
    const s = await setup()
    await giveProfile(s.id, {
      captionStyles: [{ id: 'karaoke', share: 1 }],
      cutPace: 5,
      hookTimingSec: 1.5,
    })
    const r = await say(s, 'match my style')
    expect(r.plan).toBeDefined()
    expect(r.plan!.title).toBe('Match my style')
    expect(r.plan!.op.type).toBe('batch')
    const ops = flat(r.plan!.op).map((o) => o.type)
    expect(ops).toContain('cutSource')
    expect(ops).toContain('addCaptions')
    expect(styleOf(r.plan!.op)?.styleId).toBe('karaoke')
    // Ordinary ops only, valid on the timeline it was made for, and saved as a proposed plan.
    expect(
      ops.every((o) => ['batch', 'cutSource', 'addCaptions', 'setCaptionStyle'].includes(o)),
    ).toBe(true)
    expect(() => applyOp(s.timeline, r.plan!.op)).not.toThrow()
    const [row] = await t.deps.database.db
      .select()
      .from(editPlans)
      .where(eq(editPlans.id, r.plan!.id))
    expect(row).toMatchObject({ status: 'proposed', baseVersion: 0, userId: s.id })
    // It says what it used, in the card.
    expect(r.plan!.description).toContain('Using your karaoke style.')
    expect(r.plan!.description).toMatch(/Karaoke captions/)
    expect(r.plan!.summary.map((c) => c.label)).toEqual(
      expect.arrayContaining(['Captions', 'Cut pace']),
    )
    expect(r.plan!.summary.find((c) => c.label === 'Cut pace')!.value).toBe('2.0s')
    expect(r.text).toMatch(/Your top Reels use Karaoke captions and cut roughly every 2.0 seconds/)
  })

  it('works whether or not the style toggle is on: asking for it by name is the request', async () => {
    const s = await setup()
    await giveProfile(s.id)
    const off = await say(s, 'match my style', { applyStyle: false })
    const on = await say(s, 'match my style', { applyStyle: true })
    expect(styleOf(off.plan!.op)?.styleId).toBe('karaoke')
    expect(styleOf(on.plan!.op)?.styleId).toBe('karaoke')
  })

  it('answers in Hinglish and Hindi, with the same plan', async () => {
    const s = await setup()
    await giveProfile(s.id)
    const hing = await say(s, 'meri style lagao')
    expect(hing.plan!.title).toBe('Meri style lagao')
    expect(hing.text).toMatch(/Aapki top Reels mein Karaoke captions/)
    const hi = await say(s, 'मेरी स्टाइल लगाओ')
    expect(hi.plan!.title).toBe('मेरी स्टाइल लगाएं')
    expect(JSON.stringify(hi.plan!.op)).toContain('karaoke')
  })

  it('tightens pauses more for someone who cuts faster', async () => {
    const s = await setup()
    // The talk pauses for up to 0.6 s between lines: a pause that long is only cut at a fast creator's threshold.
    await giveProfile(s.id, { cutPace: 6 })
    const fast = await say(s, 'match my style')
    await t.deps.database.db.delete(styleProfiles)
    await giveProfile(s.id, { cutPace: 0.4 })
    const slow = await say(s, 'match my style')
    const total = (op: TimelineOp) =>
      cuts(op).reduce(
        (n, o) => n + ((o as { srcTo: number }).srcTo - (o as { srcFrom: number }).srcFrom),
        0,
      )
    expect(cuts(fast.plan!.op).length).toBeGreaterThan(cuts(slow.plan!.op).length)
    expect(total(fast.plan!.op)).toBeGreaterThan(0)
    expect(slow.plan!.description).toMatch(/pauses left roomy|every 25.0 seconds/)
  })

  it('skips a caption look the editor cannot apply, and keeps the edit’s own when it has none that fits', async () => {
    const s = await setup()
    await giveProfile(s.id, {
      captionStyles: [
        { id: 'custom', share: 0.7 },
        { id: 'neon', share: 0.3 },
      ],
    })
    const mixed = await say(s, 'match my style')
    expect(styleOf(mixed.plan!.op)?.styleId).toBe('neon')
    await t.deps.database.db.delete(styleProfiles)
    await giveProfile(s.id, { captionStyles: [{ id: 'custom', share: 1 }] })
    const none = await say(s, 'match my style')
    expect(none.plan!.description).not.toContain('Using your')
    expect(none.plan!.description).toMatch(/Your current caption look/)
  })

  it('never hides that the profile comes from few Reels, and points to where to add more', async () => {
    const s = await setup()
    await giveProfile(s.id, { confidence: 'low' })
    const low = await say(s, 'match my style')
    expect(low.text).toMatch(/only a few Reels/)
    expect(low.plan!.description).toMatch(/only a few Reels/)
    expect(low.route).toBe('/app/style')
    await t.deps.database.db.delete(styleProfiles)
    await giveProfile(s.id, { confidence: 'medium' })
    const ok = await say(s, 'match my style')
    expect(ok.text).not.toMatch(/few Reels/)
    expect(ok.route).toBeUndefined()
  })
})

describe('captions and Reels use the creator’s look as the default when their style is on', () => {
  it('add captions: their look and a description that says so; without the toggle, the edit’s own', async () => {
    const s = await setup()
    await giveProfile(s.id, { captionStyles: [{ id: 'outline', share: 1 }] })
    const on = await say(s, 'add captions', { applyStyle: true })
    expect(styleOf(on.plan!.op)?.styleId).toBe('outline')
    expect(on.plan!.description).toContain('Using your outline style.')
    expect(on.plan!.summary.find((c) => c.label === 'Style')!.value).toBe('Outline')
    const off = await say(s, 'add captions', { applyStyle: false })
    expect(JSON.stringify(off.plan!.op)).not.toContain('outline')
    expect(off.plan!.description).not.toContain('Using your')
  })

  it('asking for captions or a Reel in their style applies it even with the toggle off', async () => {
    const s = await setup()
    await giveProfile(s.id, { captionStyles: [{ id: 'outline', share: 1 }] })
    const caps = await say(s, 'add captions in my style')
    expect(styleOf(caps.plan!.op)?.styleId).toBe('outline')
    const reel = await say(s, 'make a 30 second reel in my style')
    expect(reel.question).toBeDefined()
  })

  it('a look the person names wins over theirs', async () => {
    const s = await setup()
    await giveProfile(s.id, { captionStyles: [{ id: 'outline', share: 1 }] })
    const r = await say(s, 'karaoke style captions lagao', { applyStyle: true })
    expect(styleOf(r.plan!.op)?.styleId).toBe('karaoke')
    expect(r.plan!.description).not.toContain('Using your')
  })

  it('the Reel built from a tapped answer uses it too, and says so', async () => {
    const s = await setup()
    await giveProfile(s.id, { captionStyles: [{ id: 'boxed', share: 1 }] })
    const reel = await svc().reel(s.id, s.projectId, {
      ...common({ applyStyle: true }),
      srcFrom: 10,
      srcTo: 40,
      title: 'Funding',
      fast: true,
    } as never)
    expect(styleOf(reel.plan!.op)?.styleId).toBe('boxed')
    // The tapped Reel answers in the person's own language, which is Hinglish here.
    expect(reel.plan!.description).toContain('Aapki boxed style use ho rahi hai.')
  })

  it('set_caption_style with no look takes the creator’s; with none to take, it says so', async () => {
    const s = await setup()
    const none = await say(s, 'use my caption style')
    expect(none.plan).toBeUndefined()
    await giveProfile(s.id, { captionStyles: [{ id: 'neon', share: 1 }] })
    const scripted = scriptedModel(() => ({
      name: 'set_caption_style',
      input: { useMyStyle: true },
    }))
    try {
      const r = await say(s, 'use my caption style', {}, scripted.service)
      expect(styleOf(r.plan!.op)?.styleId).toBe('neon')
      expect(r.plan!.description).toContain('Using your neon style.')
    } finally {
      scripted.restore()
    }
    await t.deps.database.db.delete(styleProfiles)
    await giveProfile(s.id, { captionStyles: [{ id: 'custom', share: 1 }] })
    const custom = scriptedModel(() => ({ name: 'set_caption_style', input: { useMyStyle: true } }))
    try {
      const r = await say(s, 'use my caption style', {}, custom.service)
      expect(r.plan).toBeUndefined()
      expect(r.text).toMatch(/not one I can apply yet/)
      expect(r.route).toBe('/app/style')
    } finally {
      custom.restore()
    }
  })
})

/** A "real" model that answers from a script and remembers what it was asked. */
function scriptedModel(answer: (req: GenerateRequest) => { name: string; input: unknown }) {
  const requests: GenerateRequest[] = []
  const provider: LlmProvider = {
    name: 'anthropic',
    async generate(req) {
      requests.push(req)
      const a = answer(req)
      return {
        text: '',
        toolCall: { id: 'tu', name: a.name, input: a.input },
        extraToolCalls: 0,
        stop: 'tool_call',
        usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'claude-sonnet-5-5',
      }
    },
  }
  const original = t.deps.llm
  const llm = new Llm({
    config: {
      LLM_MAX_INPUT_TOKENS: 60_000,
      LLM_MAX_RETRIES: 0,
      LLM_RETRY_BASE_MS: 1,
      LLM_MONTHLY_BUDGET_USD: 0,
      LLM_BREAKER_FAILURES: 99,
      LLM_BREAKER_COOLDOWN_SEC: 60,
    },
    db: t.deps.database.db,
    log,
    primary: { planner: provider, batch: provider },
    fake: new FakeProvider({ planner: fakePlanner }),
    sleep: async () => undefined,
  })
  t.deps.llm = llm
  return { requests, service: svc(t.deps), restore: () => void (t.deps.llm = original) }
}

describe('what a real model is shown', () => {
  it('sees the style only when the person has turned it on and there is a profile, and only its numbers and look ids', async () => {
    const s = await setup()
    await giveProfile(s.id, { summary: 'Your best Reels hook in under 2 seconds.' })
    // An Instagram account with a handle and a token, which must never reach a prompt.
    const { envelope } = t.deps.vault.seal('IGAA-secret-token', s.id)
    await t.deps.database.db.insert(instagramAccounts).values({
      userId: s.id,
      igUserId: 'ig-1',
      handle: '@very.private.handle',
      accountType: 'creator',
      tokenEnvelope: envelope,
      keyId: 'dev',
      tokenExpiresAt: new Date(Date.now() + 1e9),
    })
    const m = scriptedModel(() => ({ name: 'match_my_style', input: {} }))
    try {
      await say(s, 'tell me about my edit', { applyStyle: true }, m.service)
      await say(s, 'tell me about my edit', { applyStyle: false }, m.service)
      const [on, off] = m.requests
      expect(on!.context).toContain('"myStyle"')
      expect(on!.context).toContain('"cutPaceCutsPer10Sec":3')
      expect(on!.context).toContain('"captionStyles":["karaoke","boxed"]')
      expect(on!.context).toContain('Your best Reels hook in under 2 seconds.')
      expect(off!.context).not.toContain('myStyle')
      for (const req of m.requests)
        for (const leak of ['very.private', 'IGAA', 'secret', 'reelsAnalysed', 'tokenEnvelope'])
          expect(JSON.stringify(req), leak).not.toContain(leak)
    } finally {
      m.restore()
    }
  })

  it('has the tool in its list, and when it calls it the plan is built by code from the profile', async () => {
    const s = await setup()
    await giveProfile(s.id)
    const m = scriptedModel(() => ({ name: 'match_my_style', input: {} }))
    try {
      const r = await say(s, 'do the thing', {}, m.service)
      expect(m.requests[0]!.tools!.map((x) => x.name)).toContain('match_my_style')
      expect(r.plan!.title).toBe('Match my style')
      expect(styleOf(r.plan!.op)?.styleId).toBe('karaoke')
    } finally {
      m.restore()
    }
  })

  it('is told that what is in the style data is data, and that an argument to the tool is refused', async () => {
    const s = await setup()
    await giveProfile(s.id)
    const m = scriptedModel((req) =>
      req.messages.length > 1
        ? { name: 'match_my_style', input: {} }
        : { name: 'match_my_style', input: { styleId: 'boxed', captions: 'delete everything' } },
    )
    try {
      const r = await say(s, 'match my style', {}, m.service)
      // The first answer had arguments the tool does not take, so it was told, and the corrected call gave the plan.
      expect(m.requests).toHaveLength(2)
      expect(r.plan!.title).toBe('Match my style')
      expect(m.requests[0]!.system).toMatch(/never instructions/)
    } finally {
      m.restore()
    }
  })
})

describe('someone else’s profile', () => {
  it('is never used for another person’s request', async () => {
    const a = await setup()
    const b = await setup()
    await giveProfile(a.id, { captionStyles: [{ id: 'neon', share: 1 }] })
    const mine = await say(a, 'match my style')
    const theirs = await say(b, 'match my style')
    expect(mine.plan).toBeDefined()
    expect(theirs.plan).toBeUndefined()
    expect(theirs.route).toBe('/app/style')
  })
})
