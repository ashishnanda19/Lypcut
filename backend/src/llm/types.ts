import type { z } from 'zod'

/**
 * The model layer's own vocabulary. Nothing here (or anywhere outside this folder) knows which vendor answers:
 * a provider turns these into its own requests and back. No provider type leaves this folder.
 */

export type LlmPurpose = 'planner' | 'highlights' | 'chapters'

/** A tool the model may call. The schema is Zod; the JSON schema sent to the model is generated from it. */
export interface ToolDefinition {
  name: string
  description: string
  schema: z.ZodType
}

/** One piece of a message. A conversation is text, the tool calls the model made, and what came back from them. */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string | LlmBlock[]
}

export interface GenerateRequest {
  purpose: LlmPurpose
  /** The static instructions. Identical on every call for a prompt version, so it can be cached. */
  system: string
  /**
   * Project data (the transcript and so on), as one block of text. It is data, never instructions; the system
   * prompt says so. Stable within a project and timeline version, so it is cached after the system prompt.
   */
  context?: string
  messages: LlmMessage[]
  tools?: ToolDefinition[]
  /** Upper bound on what the model may write back. */
  maxOutputTokens: number
  effort?: 'low' | 'medium' | 'high'
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type StopReason = 'end' | 'tool_call' | 'max_tokens' | 'refusal'

export interface GenerateResult {
  /** Free text the model wrote, if any. */
  text: string
  /** The tool call, if it made one. Its `input` is unchecked: parse it with the tool's schema. */
  toolCall?: { id: string; name: string; input: unknown }
  /** How many more tool calls it made than the one returned. The planner treats anything above 0 as malformed. */
  extraToolCalls: number
  stop: StopReason
  usage: TokenUsage
  model: string
  latencyMs: number
}

export interface LlmProvider {
  /** Short name for logs and the usage table: anthropic, fake. */
  readonly name: string
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<Omit<GenerateResult, 'latencyMs'>>
}

export type EmbeddingKind = 'query' | 'passage'

export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  /** Length of every vector. The database column is sized to it. */
  readonly dimensions: number
  /**
   * Cosine similarity below which a text is not about the query at all. It differs by model: some spread unrelated
   * texts near 0, others (like e5) keep everything above 0.75, so a fixed number would suit only one of them.
   */
  readonly similarityFloor: number
  /** Some models want to know whether a text is a search query or a passage being searched. Vectors are unit length. */
  embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<number[][]>
}

export type LlmErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'unauthorized'
  | 'bad_request'
  | 'refused'
  | 'malformed'
  | 'too_large'
  | 'unavailable'

/** Every provider failure comes out as this, so callers and the breaker never see vendor error classes. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly retryable: boolean
  readonly retryAfterMs?: number
  constructor(kind: LlmErrorKind, message: string, opts: { retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.retryable =
      kind === 'timeout' || kind === 'rate_limited' || kind === 'overloaded' || kind === 'server'
    this.retryAfterMs = opts.retryAfterMs
  }
}
