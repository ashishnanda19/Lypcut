import type { Config } from '../lib/config.js'
import type { Log } from '../lib/log.js'
import type { Database } from '../db/client.js'
import { CircuitBreaker } from './breaker.js'
import { estimateCostUsd, estimateTokens } from './pricing.js'
import { withRetry } from './retry.js'
import { LlmError, type GenerateRequest, type GenerateResult, type LlmProvider } from './types.js'
import { recordUsage, spendThisMonth, type LlmKind } from './usage.js'

export interface LlmContext {
  /** Groups the calls of one assistant request. */
  requestId?: string
  userId?: string
  projectId?: string
}

export interface LlmReply extends GenerateResult {
  provider: string
  /** The offline model answered because the real one was over budget or failing. */
  degraded: boolean
}

export interface LlmDeps {
  config: Pick<
    Config,
    | 'LLM_MAX_INPUT_TOKENS'
    | 'LLM_MAX_RETRIES'
    | 'LLM_RETRY_BASE_MS'
    | 'LLM_MONTHLY_BUDGET_USD'
    | 'LLM_BREAKER_FAILURES'
    | 'LLM_BREAKER_COOLDOWN_SEC'
  >
  db: Database['db']
  log: Log
  /** The real provider for each kind of work, or null to run on the offline model only. */
  primary: { planner: LlmProvider; batch: LlmProvider } | null
  fake: LlmProvider
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

const KIND_OF = { planner: 'planner', highlights: 'highlights', chapters: 'chapters' } as const

/**
 * The one door to the language model. It chooses who answers (the real model, or the offline one when the real one is
 * over its monthly budget or has been failing), refuses oversized requests, retries what is worth retrying, and records
 * what every call cost. Nothing in the logs or the usage table holds a prompt or a reply.
 */
export class Llm {
  private readonly breaker: CircuitBreaker
  private spend: { at: number; usd: number } | null = null
  private lastWarn = new Map<string, number>()

  constructor(private readonly d: LlmDeps) {
    this.breaker = new CircuitBreaker(
      d.config.LLM_BREAKER_FAILURES,
      d.config.LLM_BREAKER_COOLDOWN_SEC * 1000,
      d.now,
    )
  }

  /** Whether a real model is configured at all (false means everything runs on the offline model). */
  get hasRealModel(): boolean {
    return this.d.primary !== null
  }

  async generate(
    req: GenerateRequest,
    ctx: LlmContext = {},
    signal?: AbortSignal,
  ): Promise<LlmReply> {
    const kind: LlmKind = KIND_OF[req.purpose]
    const inputEstimate =
      estimateTokens(req.system) +
      estimateTokens(req.context ?? '') +
      estimateTokens(JSON.stringify(req.messages))
    if (inputEstimate > this.d.config.LLM_MAX_INPUT_TOKENS) {
      throw new LlmError('too_large', 'That request is too large for the model.')
    }

    const choice = await this.choose(req)
    const started = Date.now()
    try {
      const raw = await withRetry(
        () => choice.provider.generate(req, signal),
        {
          retries: choice.provider === this.d.fake ? 0 : this.d.config.LLM_MAX_RETRIES,
          baseMs: this.d.config.LLM_RETRY_BASE_MS,
          sleep: this.d.sleep,
          random: this.d.random,
          onRetry: (e, attempt, waitMs) =>
            this.d.log.warn(
              { kind, attempt, error: e.kind, waitMs },
              'model call failed, retrying',
            ),
        },
        signal,
      )
      const reply: LlmReply = {
        ...raw,
        latencyMs: Date.now() - started,
        provider: choice.provider.name,
        degraded: choice.degraded,
      }
      if (choice.provider !== this.d.fake) this.breaker.success()
      await this.record(kind, ctx, reply, raw.stop === 'refusal' ? 'refused' : 'ok')
      this.d.log.info(
        {
          kind,
          provider: reply.provider,
          model: reply.model,
          degraded: reply.degraded,
          projectId: ctx.projectId,
          inputTokens: reply.usage.inputTokens,
          outputTokens: reply.usage.outputTokens,
          cacheReadTokens: reply.usage.cacheReadTokens,
          latencyMs: reply.latencyMs,
          stop: reply.stop,
          tool: reply.toolCall?.name,
        },
        'model call',
      )
      return reply
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unavailable', 'The model call failed.')
      if (choice.provider !== this.d.fake) this.breaker.failure()
      await this.recordFailure(kind, ctx, choice, err, Date.now() - started)
      this.d.log.warn(
        { kind, provider: choice.provider.name, error: err.kind, projectId: ctx.projectId },
        'model call failed',
      )
      throw err
    }
  }

  private async choose(
    req: GenerateRequest,
  ): Promise<{ provider: LlmProvider; degraded: boolean }> {
    const real = this.d.primary
      ? req.purpose === 'planner'
        ? this.d.primary.planner
        : this.d.primary.batch
      : null
    if (!real) return { provider: this.d.fake, degraded: false }
    // Budget first: the breaker hands out one trial call after a cool-down, and a trial we then decline to make would
    // leave it waiting for a result that never comes.
    if (await this.overBudget()) {
      this.warnOnce('budget', 'the monthly model budget is used up; using the offline model')
      return { provider: this.d.fake, degraded: true }
    }
    if (!this.breaker.allow()) {
      this.warnOnce(
        'breaker',
        'the model service has been failing; using the offline model for now',
      )
      return { provider: this.d.fake, degraded: true }
    }
    return { provider: real, degraded: false }
  }

  private async overBudget(): Promise<boolean> {
    const cap = this.d.config.LLM_MONTHLY_BUDGET_USD
    if (cap <= 0) return false
    const now = (this.d.now ?? Date.now)()
    // Summing a month of rows on every call would be wasteful; a figure up to 30 seconds old is fine for a ceiling.
    if (!this.spend || now - this.spend.at > 30_000) {
      this.spend = { at: now, usd: await spendThisMonth(this.d.db) }
    }
    return this.spend.usd >= cap
  }

  private warnOnce(key: string, message: string) {
    const now = (this.d.now ?? Date.now)()
    if (now - (this.lastWarn.get(key) ?? 0) < 60_000) return
    this.lastWarn.set(key, now)
    this.d.log.warn({ reason: key }, message)
  }

  private async record(kind: LlmKind, ctx: LlmContext, reply: LlmReply, outcome: string) {
    const costUsd = reply.provider === 'fake' ? 0 : estimateCostUsd(reply.model, reply.usage)
    if (this.spend) this.spend.usd += costUsd
    await this.safeRecord({
      ...ctx,
      kind,
      provider: reply.provider,
      model: reply.model,
      ...reply.usage,
      costUsd,
      latencyMs: reply.latencyMs,
      outcome,
      degraded: reply.degraded,
    })
  }

  private async recordFailure(
    kind: LlmKind,
    ctx: LlmContext,
    choice: { provider: LlmProvider; degraded: boolean },
    err: LlmError,
    latencyMs: number,
  ) {
    await this.safeRecord({
      ...ctx,
      kind,
      provider: choice.provider.name,
      model: choice.provider.name,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      latencyMs,
      outcome: err.kind,
      degraded: choice.degraded,
    })
  }

  /** Bookkeeping must never turn a good answer into a failure. */
  private async safeRecord(row: Parameters<typeof recordUsage>[1]) {
    try {
      await recordUsage(this.d.db, row)
    } catch (e) {
      this.d.log.error({ err: e }, 'could not record model usage')
    }
  }
}
