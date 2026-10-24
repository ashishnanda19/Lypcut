import { estimateTokens } from './pricing.js'
import type { GenerateRequest, GenerateResult, LlmProvider } from './types.js'

/** What a handler answers with. The provider adds the model name and token counts. */
export type FakeAnswer = Pick<GenerateResult, 'text' | 'toolCall'> &
  Partial<Pick<GenerateResult, 'extraToolCalls' | 'stop'>>
export type FakeHandler = (req: GenerateRequest) => FakeAnswer

/**
 * The offline model: deterministic, free, needs no key. It stands in for Claude in development, CI and demos, and
 * takes over when the real one is over budget or failing. It does no language modelling of its own; for each kind of
 * request (planning, highlight scoring, chapter titles) the module that makes the request supplies the rules, so the
 * rules live next to the prompt they replace and are tested with it.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake'

  constructor(
    private readonly handlers: Partial<Record<GenerateRequest['purpose'], FakeHandler>> = {},
  ) {}

  async generate(req: GenerateRequest): Promise<Omit<GenerateResult, 'latencyMs'>> {
    const handler = this.handlers[req.purpose]
    const answer: FakeAnswer = handler ? handler(req) : { text: '' }
    const input =
      estimateTokens(req.system) +
      estimateTokens(req.context ?? '') +
      estimateTokens(JSON.stringify(req.messages))
    return {
      text: answer.text,
      toolCall: answer.toolCall,
      extraToolCalls: answer.extraToolCalls ?? 0,
      stop: answer.stop ?? (answer.toolCall ? 'tool_call' : 'end'),
      // Token counts are made up from the sizes, so budgets and tests see realistic numbers but nothing is spent.
      usage: {
        inputTokens: input,
        outputTokens: estimateTokens(answer.text) + 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: 'fake',
    }
  }
}
