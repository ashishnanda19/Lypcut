import type { Config } from '../lib/config.js'
import type { Log } from '../lib/log.js'
import type { Database } from '../db/client.js'
import { AnthropicProvider } from './anthropic.js'
import { FAKE_DIMENSIONS, FakeEmbeddingProvider } from './fake-embedding.js'
import { HostedEmbeddingProvider } from './hosted-embedding.js'
import { hasModel, TransformersEmbeddingProvider } from './transformers-embedding.js'
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
export { estimateCostUsd, estimateRequestTokens, estimateTokens } from './pricing.js'

export type EmbeddingConfig = Pick<
  Config,
  | 'EMBEDDING_PROVIDER'
  | 'EMBEDDING_MODEL'
  | 'EMBEDDING_MODEL_DIR'
  | 'EMBEDDING_API_URL'
  | 'EMBEDDING_API_KEY'
  | 'EMBEDDING_API_MODEL'
  | 'EMBEDDING_SIMILARITY_FLOOR'
>

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

/**
 * Chooses the embedding provider. `auto` is the multilingual model on this machine if it has been downloaded, and the
 * offline hashed-word stand-in otherwise (said once in the log), so search by meaning degrades instead of failing.
 */
export function createEmbeddings(config: EmbeddingConfig, log: Log): EmbeddingProvider {
  const floor = config.EMBEDDING_SIMILARITY_FLOOR
  const withFloor = <T extends EmbeddingProvider>(p: T): T => {
    if (floor !== undefined) Object.defineProperty(p, 'similarityFloor', { value: floor })
    return p
  }
  const local = () =>
    withFloor(
      new TransformersEmbeddingProvider({
        model: config.EMBEDDING_MODEL,
        dir: config.EMBEDDING_MODEL_DIR,
      }),
    )
  switch (config.EMBEDDING_PROVIDER) {
    case 'fake':
      return withFloor(new FakeEmbeddingProvider())
    case 'local':
      return local()
    case 'hosted':
      return new HostedEmbeddingProvider({
        url: config.EMBEDDING_API_URL!,
        apiKey: config.EMBEDDING_API_KEY!,
        model: config.EMBEDDING_API_MODEL,
        dimensions: FAKE_DIMENSIONS,
        similarityFloor: floor ?? 0.5,
        timeoutMs: 15_000,
      })
    case 'auto':
      if (hasModel(config.EMBEDDING_MODEL_DIR, config.EMBEDDING_MODEL)) return local()
      log.info(
        { model: config.EMBEDDING_MODEL, dir: config.EMBEDDING_MODEL_DIR },
        'embedding model not downloaded; search by meaning uses the offline stand-in (npm run models:download-embeddings)',
      )
      return withFloor(new FakeEmbeddingProvider())
  }
}
