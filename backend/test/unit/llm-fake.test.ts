import { describe, expect, it } from 'vitest'
import { FAKE_DIMENSIONS, FakeEmbeddingProvider } from '../../src/llm/fake-embedding.js'
import { FakeProvider } from '../../src/llm/fake.js'
import type { GenerateRequest } from '../../src/llm/types.js'

const req = (purpose: GenerateRequest['purpose'], text = 'hello'): GenerateRequest => ({
  purpose,
  system: 'sys',
  messages: [{ role: 'user', content: text }],
  maxOutputTokens: 100,
})

describe('the offline model', () => {
  it('answers with whatever the module’s rules say for that kind of request', async () => {
    const fake = new FakeProvider({
      planner: (r) => ({
        text: '',
        toolCall: { id: 't1', name: 'remove_fillers', input: { echo: r.messages.length } },
      }),
      highlights: () => ({ text: 'scored' }),
    })
    const planner = await fake.generate(req('planner'))
    expect(planner.toolCall).toEqual({ id: 't1', name: 'remove_fillers', input: { echo: 1 } })
    expect(planner.stop).toBe('tool_call')
    expect((await fake.generate(req('highlights'))).text).toBe('scored')
    expect(planner.model).toBe('fake')
  })

  it('is deterministic: the same request always gets the same answer', async () => {
    const fake = new FakeProvider({
      planner: (r) => ({ text: String(r.messages[0]!.content).toUpperCase() }),
    })
    expect(await fake.generate(req('planner', 'abc'))).toEqual(
      await fake.generate(req('planner', 'abc')),
    )
  })

  it('has an empty answer for a kind of request nobody wrote rules for', async () => {
    const r = await new FakeProvider().generate(req('chapters'))
    expect(r.text).toBe('')
    expect(r.toolCall).toBeUndefined()
    expect(r.stop).toBe('end')
  })

  it('reports plausible token counts, and nothing is spent', async () => {
    const r = await new FakeProvider({ planner: () => ({ text: 'hi' }) }).generate(
      req('planner', 'x'.repeat(3000)),
    )
    expect(r.usage.inputTokens).toBeGreaterThan(900)
    expect(r.usage.cacheReadTokens).toBe(0)
  })
})

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)

describe('offline embeddings', () => {
  const e = new FakeEmbeddingProvider()
  const one = async (t: string) => (await e.embed([t], 'passage'))[0]!

  it('makes unit-length vectors of the promised size, the same every time', async () => {
    const v = await one('funding kaise raise karein')
    expect(v).toHaveLength(FAKE_DIMENSIONS)
    expect(e.dimensions).toBe(FAKE_DIMENSIONS)
    expect(Math.hypot(...v)).toBeCloseTo(1)
    expect(await one('funding kaise raise karein')).toEqual(v)
  })

  it('puts texts that share words closer than texts that do not', async () => {
    const a = await one('mujhe funding chahiye investors se')
    const near = await one('investors se funding kaise milegi')
    const far = await one('khana banane ka tarika aur masale')
    expect(cosine(a, near)).toBeGreaterThan(cosine(a, far) + 0.2)
  })

  it('treats a Roman and a Devanagari spelling as the same word', async () => {
    const roman = await one('funding investors')
    const dev = await one('फंडिंग इन्वेस्टर्स')
    const other = await one('cooking recipe')
    expect(cosine(roman, dev)).toBeGreaterThan(0.6)
    expect(cosine(roman, dev)).toBeGreaterThan(cosine(roman, other) + 0.4)
  })

  it('puts topic words near each other (paisa near funding)', async () => {
    const paisa = await one('paisa')
    expect(cosine(paisa, await one('funding'))).toBeGreaterThan(
      cosine(paisa, await one('table')) + 0.3,
    )
  })

  it('gives an empty text a zero vector instead of failing', async () => {
    expect(await one('')).toEqual(new Array(FAKE_DIMENSIONS).fill(0))
  })

  it('embeds a batch in order', async () => {
    const [a, b] = await e.embed(['funding', 'recipe'], 'passage')
    expect(a).toEqual(await one('funding'))
    expect(b).toEqual(await one('recipe'))
  })
})
