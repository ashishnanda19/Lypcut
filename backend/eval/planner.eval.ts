import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { applyOp, type TimelineOp } from '@lypcut/timeline-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editPlans } from '../src/db/schema/index.js'
import { AnthropicProvider } from '../src/llm/anthropic.js'
import { FakeProvider } from '../src/llm/fake.js'
import { estimateCostUsd } from '../src/llm/pricing.js'
import { Llm } from '../src/llm/service.js'
import type { GenerateRequest, GenerateResult, LlmProvider } from '../src/llm/types.js'
import { fakePlanner } from '../src/planner/fake.js'
import { PlannerService } from '../src/planner/service.js'
import type { PlannerResult } from '../src/planner/types.js'
import { createTestApp, type TestApp } from '../test/helpers/app.js'
import { readyProject } from '../test/helpers/ready.js'
import { signup } from '../test/helpers/world.js'
import { LINES } from '../test/helpers/transcript-fixture.js'
import { GOLDEN } from './golden.js'
import { summarize, type CaseRun, type Outcome, type Summary } from './metrics.js'

/**
 * How well the assistant turns messages into the right tool and a valid plan.
 *
 *   npm run eval                            the offline model: free, deterministic, what CI runs
 *   EVAL_PROVIDER=anthropic npm run eval    Claude, using ANTHROPIC_API_KEY (a few cents for the whole set)
 *
 * Every message goes through the real PlannerService on a real project in the test database, so what is measured is the
 * whole path: the model's tool choice, argument checking, the plan builders, the engine's dry run and plan saving.
 */

const mode = (process.env.EVAL_PROVIDER ?? 'fake') as 'fake' | 'anthropic'
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== ''
    ? v
    : fallback
}

/** The bars a run has to clear. Claude is held to a stricter accuracy and a latency bound; the offline rules are not slow. */
const BARS =
  mode === 'anthropic'
    ? {
        toolAccuracy: num('EVAL_MIN_TOOL_ACCURACY', 0.9),
        outcomeAccuracy: num('EVAL_MIN_OUTCOME_ACCURACY', 0.9),
        p95Ms: num('EVAL_MAX_P95_MS', 20_000),
        repairRate: num('EVAL_MAX_REPAIR_RATE', 0.15),
      }
    : {
        toolAccuracy: num('EVAL_MIN_TOOL_ACCURACY', 0.95),
        outcomeAccuracy: num('EVAL_MIN_OUTCOME_ACCURACY', 0.95),
        p95Ms: num('EVAL_MAX_P95_MS', 5_000),
        repairRate: num('EVAL_MAX_REPAIR_RATE', 0.05),
      }

/** Remembers what the model was asked and what it answered, then passes the answer on. */
class Recorder implements LlmProvider {
  readonly name: string
  calls: Array<{ tool: string; usage: GenerateResult['usage']; model: string }> = []

  constructor(private readonly inner: LlmProvider) {
    this.name = inner.name
  }

  async generate(req: GenerateRequest) {
    const reply = await this.inner.generate(req)
    this.calls.push({
      tool: reply.toolCall?.name ?? 'none',
      usage: reply.usage,
      model: reply.model,
    })
    return reply
  }
}

const FORBIDDEN = new Set(['patch', 'restoreSource'])
function usesForbiddenOp(op: TimelineOp): boolean {
  if (FORBIDDEN.has(op.type)) return true
  return op.type === 'batch' && op.ops.some(usesForbiddenOp)
}

const outcomeOf = (r: PlannerResult): Outcome =>
  r.plan ? 'plan' : r.question ? 'question' : r.action ? 'action' : 'text'
const asList = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

let t: TestApp
beforeAll(async () => {
  t = await createTestApp({ LLM_MONTHLY_BUDGET_USD: '0', LLM_MAX_RETRIES: '1' })
})
afterAll(() => t.close())

describe(`planner evaluation (${mode})`, () => {
  it(`runs the ${GOLDEN.length} golden prompts and clears the bars`, async () => {
    const log = pino({ level: 'silent' })
    const inner: LlmProvider =
      mode === 'anthropic'
        ? new AnthropicProvider({
            apiKey:
              process.env.ANTHROPIC_API_KEY ??
              (() => {
                throw new Error('EVAL_PROVIDER=anthropic needs ANTHROPIC_API_KEY.')
              })(),
            baseURL: t.deps.config.ANTHROPIC_BASE_URL,
            model: t.deps.config.LLM_MODEL_PLANNER,
            timeoutMs: t.deps.config.LLM_TIMEOUT_MS,
            strictTools: t.deps.config.LLM_STRICT_TOOLS,
          })
        : new FakeProvider({ planner: fakePlanner })
    const recorder = new Recorder(inner)
    const llm = new Llm({
      config: { ...t.deps.config, LLM_MONTHLY_BUDGET_USD: 0 },
      db: t.deps.database.db,
      log,
      primary: { planner: recorder, batch: recorder },
      fake: new FakeProvider({ planner: fakePlanner }),
    })
    const service = new PlannerService({ ...t.deps, llm }, log)

    const person = await signup(t, 'studio')
    const project = await readyProject(t, person, { content: LINES, fitTimeline: true })

    const runs: CaseRun[] = []
    for (const c of GOLDEN) {
      recorder.calls = []
      const started = performance.now()
      const result = await service.message(person.id, project.projectId, {
        text: c.text,
        playhead: c.playhead ?? 0,
        applyStyle: false,
        history: [],
      })
      const latencyMs = performance.now() - started
      const notes: string[] = []

      const tool = recorder.calls[0]?.tool ?? 'none'
      const finalTool = recorder.calls.at(-1)?.tool ?? 'none'
      const outcome = outcomeOf(result)
      const toolOk = asList(c.tool).includes(tool)
      const outcomeOk = asList(c.outcome).includes(outcome)
      if (!toolOk) notes.push(`tool ${tool}, wanted ${asList(c.tool).join(' or ')}`)
      if (!outcomeOk) notes.push(`got ${outcome}, wanted ${asList(c.outcome).join(' or ')}`)
      if (c.noModel && recorder.calls.length)
        notes.push('reached the model; a fixed rule should answer')
      if (c.script === 'devanagari' && !/[ऀ-ॿ]/.test(result.text))
        notes.push('reply not in Devanagari')

      let planValid: boolean | undefined
      if (result.plan) {
        const [saved] = await t.deps.database.db
          .select({ id: editPlans.id })
          .from(editPlans)
          .where(eq(editPlans.id, result.plan.id))
        try {
          applyOp(project.timeline, result.plan.op)
          planValid = !!saved && !usesForbiddenOp(result.plan.op)
        } catch {
          planValid = false
        }
        if (!planValid) notes.push('INVALID PLAN RETURNED')
      }

      const tokens = recorder.calls.reduce(
        (n, k) => ({
          in: n.in + k.usage.inputTokens + k.usage.cacheReadTokens + k.usage.cacheWriteTokens,
          out: n.out + k.usage.outputTokens,
        }),
        { in: 0, out: 0 },
      )
      runs.push({
        id: c.id,
        prompt: c.text,
        tool,
        finalTool,
        outcome,
        calls: recorder.calls.length,
        latencyMs,
        inputTokens: tokens.in,
        outputTokens: tokens.out,
        costUsd:
          mode === 'fake'
            ? 0
            : recorder.calls.reduce((n, k) => n + estimateCostUsd(k.model, k.usage), 0),
        planValid,
        toolOk,
        outcomeOk,
        notes,
      })
    }

    const summary = summarize(runs)
    report(runs, summary)
    save(runs, summary)

    // An invalid plan coming back is never acceptable, whatever the model.
    expect(runs.filter((r) => r.planValid === false).map((r) => r.id)).toEqual([])
    expect(summary.toolAccuracy).toBeGreaterThanOrEqual(BARS.toolAccuracy)
    expect(summary.outcomeAccuracy).toBeGreaterThanOrEqual(BARS.outcomeAccuracy)
    expect(summary.latencyP95Ms).toBeLessThanOrEqual(BARS.p95Ms)
    expect(summary.repairRate).toBeLessThanOrEqual(BARS.repairRate)
  })
})

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const out = (s: string) => process.stdout.write(`${s}\n`)

function report(runs: CaseRun[], s: Summary) {
  const wrong = runs.filter((r) => r.notes.length)
  out('')
  out(
    `Planner evaluation: ${mode}${mode === 'anthropic' ? ` (${t.deps.config.LLM_MODEL_PLANNER})` : ' (offline model)'}`,
  )
  out('─'.repeat(64))
  out(`prompts                ${s.cases}   (model calls: ${s.modelCalls})`)
  out(`tool accuracy          ${pct(s.toolAccuracy)}   (bar ${pct(BARS.toolAccuracy)})`)
  out(`outcome accuracy       ${pct(s.outcomeAccuracy)}   (bar ${pct(BARS.outcomeAccuracy)})`)
  out(`plans returned         ${s.plans}, valid ${pct(s.validity)}   (bar 100%)`)
  out(`repair rate            ${pct(s.repairRate)}   (bar ≤ ${pct(BARS.repairRate)})`)
  out(
    `latency p50 / p95      ${s.latencyP50Ms.toFixed(0)} ms / ${s.latencyP95Ms.toFixed(0)} ms   (bar p95 ≤ ${BARS.p95Ms} ms)`,
  )
  out(
    `tokens per request     ${s.inputTokensPerRequest.toFixed(0)} in, ${s.outputTokensPerRequest.toFixed(0)} out`,
  )
  out(
    `estimated cost         $${s.costPerRequestUsd.toFixed(5)} per request, $${s.costPer1000Usd.toFixed(2)} per 1,000`,
  )
  if (wrong.length) {
    out('')
    out('Misses')
    for (const r of wrong) out(`  ${r.id.padEnd(22)} “${r.prompt}” — ${r.notes.join('; ')}`)
  }
  out('')
}

function save(runs: CaseRun[], summary: Summary) {
  const dir = path.resolve(import.meta.dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `latest-${mode}.json`),
    JSON.stringify({ mode, at: new Date().toISOString(), summary, runs }, null, 2),
  )
}
