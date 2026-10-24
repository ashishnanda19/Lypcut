import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LlmBlock,
  type LlmMessage,
  type LlmProvider,
  type StopReason,
} from './types.js'

export interface AnthropicOptions {
  apiKey: string
  baseURL?: string
  model: string
  timeoutMs: number
  /** Ask the API to guarantee tool arguments match their schema. */
  strictTools: boolean
  /** Replaced in tests, so no request leaves the machine. */
  fetch?: typeof fetch
}

/**
 * Claude, behind the provider interface. This is the only file that knows about Anthropic's SDK or its types.
 *
 * What it sends, and why:
 *  - the system prompt and the project data are marked cacheable, so a conversation about one video pays for them once;
 *  - no temperature (Claude's current models refuse sampling settings) and no `thinking` field (thinking is the model's
 *    own call); `effort` is the lever for speed;
 *  - tool choice is automatic: a plain-text answer is a valid answer, and forcing a tool is not offered by these models.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  private readonly client: Anthropic

  constructor(private readonly opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      // Retries are ours (jittered, counted, logged), not the SDK's.
      maxRetries: 0,
      timeout: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
  }

  async generate(
    req: GenerateRequest,
    signal?: AbortSignal,
  ): Promise<Omit<GenerateResult, 'latencyMs'>> {
    let res: Anthropic.Message
    try {
      res = await this.client.messages.create(this.body(req), { signal })
    } catch (e) {
      throw mapError(e)
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const first = calls[0]
    return {
      text,
      toolCall: first ? { id: first.id, name: first.name, input: first.input } : undefined,
      extraToolCalls: Math.max(0, calls.length - 1),
      stop: stopOf(res.stop_reason),
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      model: res.model,
    }
  }

  private body(req: GenerateRequest): Anthropic.MessageCreateParamsNonStreaming {
    const messages = req.messages.map(toMessage)
    // The project data rides on the first user turn, cacheable, ahead of whatever the person said.
    if (req.context) {
      const head = messages[0]
      const block: Anthropic.ContentBlockParam = {
        type: 'text',
        text: req.context,
        cache_control: { type: 'ephemeral' },
      }
      if (head?.role === 'user') {
        head.content = [
          block,
          ...(typeof head.content === 'string'
            ? [{ type: 'text' as const, text: head.content }]
            : head.content),
        ]
      } else {
        messages.unshift({ role: 'user', content: [block] })
      }
    }
    return {
      model: this.opts.model,
      max_tokens: req.maxOutputTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: z.toJSONSchema(t.schema, {
                target: 'draft-7',
              }) as Anthropic.Tool.InputSchema,
              ...(this.opts.strictTools ? { strict: true } : {}),
            })),
            tool_choice: { type: 'auto' as const },
          }
        : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    }
  }
}

function toMessage(m: LlmMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  return { role: m.role, content: m.content.map(toBlock) }
}

function toBlock(b: LlmBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text }
    case 'tool_call':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.id,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      }
  }
}

function stopOf(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_call'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'end'
  }
}

/** Vendor errors in, our errors out. Only the status and the kind of failure are kept: never a prompt or a key. */
export function mapError(e: unknown): LlmError {
  if (e instanceof LlmError) return e
  if (e instanceof Anthropic.APIUserAbortError)
    return new LlmError('unavailable', 'The request was cancelled.')
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new LlmError('timeout', 'The model took too long.')
  if (e instanceof Anthropic.APIConnectionError)
    return new LlmError('unavailable', 'Could not reach the model.')
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0
    const retryAfter = Number(e.headers?.get?.('retry-after'))
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
    if (status === 429)
      return new LlmError('rate_limited', 'The model service is rate limiting us.', {
        retryAfterMs,
      })
    if (status === 529)
      return new LlmError('overloaded', 'The model service is overloaded.', { retryAfterMs })
    if (status === 401 || status === 403)
      return new LlmError('unauthorized', `The model service refused our credentials (${status}).`)
    if (status >= 500) return new LlmError('server', `The model service failed (${status}).`)
    return new LlmError('bad_request', `The model service rejected the request (${status}).`)
  }
  return new LlmError('unavailable', 'The model call failed.')
}
