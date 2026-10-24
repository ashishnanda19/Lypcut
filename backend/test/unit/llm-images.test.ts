import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../src/llm/anthropic.js'
import { estimateRequestTokens, IMAGE_TOKENS } from '../../src/llm/pricing.js'
import type { GenerateRequest } from '../../src/llm/types.js'

const jpeg = Buffer.alloc(60_000, 7).toString('base64')

const request = (images: number): GenerateRequest => ({
  purpose: 'style',
  system: 'Label the captions.',
  context: '<data>\n{"videos":[{"id":"a"}]}\n</data>',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Label the captions of every video below.' },
        ...Array.from({ length: images }, () => ({
          type: 'image' as const,
          mediaType: 'image/jpeg' as const,
          data: jpeg,
        })),
      ],
    },
  ],
  maxOutputTokens: 500,
})

describe('pictures in a request', () => {
  it('reach Claude as base64 image blocks, after the cached data block, with their media type', async () => {
    let body: Record<string, any> = {} // eslint-disable-line @typescript-eslint/no-explicit-any -- inspecting what was sent
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-5-5',
      timeoutMs: 5000,
      strictTools: false,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    await p.generate(request(2))
    const content = body.messages[0].content as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'image'])
    expect(content[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(content[2]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: jpeg },
    })
  })

  it('are sized as pictures, not as the text that carries them', () => {
    const none = estimateRequestTokens(request(0))
    const four = estimateRequestTokens(request(4))
    // Each picture costs its fixed share, plus the few tokens of its block's JSON wrapper.
    expect(four - none).toBeGreaterThanOrEqual(4 * IMAGE_TOKENS)
    expect(four - none).toBeLessThan(4 * IMAGE_TOKENS + 200)
    // 240 KB of base64 as text would be tens of thousands of tokens; it must not trip the size limit.
    expect(four).toBeLessThan(10_000)
  })
})
