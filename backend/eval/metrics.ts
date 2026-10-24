/** The numbers the evaluation reports, kept apart from the harness so they can be tested on their own. */

/** The value at or below which `p` (0-1) of the sample falls, by nearest rank. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!
}

export const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0

export const rate = (hits: number, of: number): number => (of ? hits / of : 1)

export type Outcome = 'plan' | 'question' | 'action' | 'text'

/** What one prompt did, as recorded by the harness. */
export interface CaseRun {
  id: string
  prompt: string
  /** The tool the model chose first, or `none`. */
  tool: string
  /** The tool it ended on, after any corrections. */
  finalTool: string
  outcome: Outcome
  /** Model calls made for the request (more than one means it was asked to correct itself). */
  calls: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Set when a plan came back: did it pass the engine's dry run and use only allowed ops. */
  planValid?: boolean
  toolOk: boolean
  outcomeOk: boolean
  /** Why it failed a check, for the report. */
  notes: string[]
}

export interface Summary {
  cases: number
  toolAccuracy: number
  outcomeAccuracy: number
  plans: number
  /** Share of plans that were valid. Anything under 1 is a bug: an invalid plan must never come back. */
  validity: number
  /** Share of requests that reached the model and needed more than one call. */
  repairRate: number
  modelCalls: number
  latencyP50Ms: number
  latencyP95Ms: number
  inputTokensPerRequest: number
  outputTokensPerRequest: number
  costPerRequestUsd: number
  costPer1000Usd: number
}

export function summarize(runs: CaseRun[]): Summary {
  const reached = runs.filter((r) => r.calls > 0)
  const plans = runs.filter((r) => r.outcome === 'plan')
  const cost = mean(runs.map((r) => r.costUsd))
  return {
    cases: runs.length,
    toolAccuracy: rate(runs.filter((r) => r.toolOk).length, runs.length),
    outcomeAccuracy: rate(runs.filter((r) => r.outcomeOk).length, runs.length),
    plans: plans.length,
    validity: rate(plans.filter((r) => r.planValid).length, plans.length),
    repairRate: reached.length ? reached.filter((r) => r.calls > 1).length / reached.length : 0,
    modelCalls: runs.reduce((n, r) => n + r.calls, 0),
    latencyP50Ms: percentile(
      runs.map((r) => r.latencyMs),
      0.5,
    ),
    latencyP95Ms: percentile(
      runs.map((r) => r.latencyMs),
      0.95,
    ),
    inputTokensPerRequest: mean(runs.map((r) => r.inputTokens)),
    outputTokensPerRequest: mean(runs.map((r) => r.outputTokens)),
    costPerRequestUsd: cost,
    costPer1000Usd: cost * 1000,
  }
}
