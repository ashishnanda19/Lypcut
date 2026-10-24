import type { Config } from '../lib/config.js'
import type { Log } from '../lib/log.js'
import type { Database } from '../db/client.js'
import { AnthropicProvider } from './anthropic.js'
import { FakeEmbeddingProvider } from './fake-embedding.js'
import { FakeProvider, type FakeHandler } from './fake.js'
import { Llm } from './service.js'
import type { EmbeddingProvider, GenerateRequest } from './types.js'

export { Llm } from './service.js'
export type { LlmContext, LlmReply } from './service.js'
export { LlmError } from './types.js'
export type {
  EmbeddingKind,
  EmbeddingProvider,
  GenerateRequest,
  GenerateResult,
  LlmBlock,
  LlmMessage,
  LlmProvider,
  LlmPurpose,
  ToolDefinition,
} from './types.js'
export { FakeProvider } from './fake.js'
export type { FakeAnswer, FakeHandler } from './fake.js'
export { FakeEmbeddingProvider } from './fake-embedding.js'
export { estimateCostUsd, estimateTokens } from './pricing.js'

export type LlmConfig = Pick<
  Config,
  | 'LLM_PROVIDER'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_BASE_URL'
  | 'LLM_MODEL_PLANNER'
  | 'LLM_MODEL_BATCH'
  | 'LLM_STRICT_TOOLS'
  | 'LLM_TIMEOUT_MS'
  | 'LLM_MAX_INPUT_TOKENS'
  | 'LLM_MAX_RETRIES'
  | 'LLM_RETRY_BASE_MS'
  | 'LLM_MONTHLY_BUDGET_USD'
  | 'LLM_BREAKER_FAILURES'
  | 'LLM_BREAKER_COOLDOWN_SEC'
>

/**
 * Builds the model layer from the environment. `auto` means Claude when there is a key and the offline model when there
 * is not, so the whole product runs with no account. `handlers` are the offline model's rules for each kind of request,
 * supplied by the modules that make those requests.
 */
export function createLlm(
  config: LlmConfig,
  deps: {
    db: Database['db']
    log: Log
    handlers?: Partial<Record<GenerateRequest['purpose'], FakeHandler>>
  },
): Llm {
  const wantsReal =
    config.LLM_PROVIDER === 'anthropic' ||
    (config.LLM_PROVIDER === 'auto' && !!config.ANTHROPIC_API_KEY)
  const make = (model: string) =>
    new AnthropicProvider({
      apiKey: config.ANTHROPIC_API_KEY!,
      baseURL: config.ANTHROPIC_BASE_URL,
      model,
      timeoutMs: config.LLM_TIMEOUT_MS,
      strictTools: config.LLM_STRICT_TOOLS,
    })
  return new Llm({
    config,
    db: deps.db,
    log: deps.log,
    primary: wantsReal
      ? { planner: make(config.LLM_MODEL_PLANNER), batch: make(config.LLM_MODEL_BATCH) }
      : null,
    fake: new FakeProvider(deps.handlers),
  })
}

/** Embeddings come from the offline hashed-word model until a trained one is configured (see the search module). */
export function createEmbeddingFallback(): EmbeddingProvider {
  return new FakeEmbeddingProvider()
}
