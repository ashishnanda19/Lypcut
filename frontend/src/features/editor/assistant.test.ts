import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '@/api/client'
import type { ChatMessage, QuestionCard } from '@/types'

const post = vi.fn()
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ClientModule>('@/api/client')
  return { ...actual, api: { post: (...a: unknown[]) => post(...a) } }
})
const flush = vi.fn(async () => undefined)
vi.mock('./sync', () => ({ flushSaves: () => flush() }))

import { ApiError } from '@/api/client'
import {
  answerAssistant,
  askAssistant,
  failure,
  reelAssistant,
  type AssistantContext,
} from './assistant'

const msg = (i: number, from: 'user' | 'ai' = 'user'): ChatMessage => ({
  id: `m${i}`,
  from,
  text: `turn ${i}`,
  at: i,
})
const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  projectId: 'p1',
  playhead: 12.3456,
  applyStyle: false,
  messages: [],
  lang: 'hinglish',
  ...over,
})

beforeEach(() => {
  post.mockReset()
  flush.mockClear()
})

describe('asking the assistant', () => {
  it('sends the message, the playhead and the last few turns to the project’s assistant', async () => {
    post.mockResolvedValue({ text: 'ok' })
    const messages = Array.from({ length: 12 }, (_, i) => msg(i, i % 2 ? 'ai' : 'user'))
    const res = await askAssistant(ctx({ messages }), 'filler words hatao')
    expect(res).toEqual({ text: 'ok' })
    const [path, body] = post.mock.calls[0]!
    expect(path).toBe('/projects/p1/assistant/messages')
    expect(body).toMatchObject({ text: 'filler words hatao', playhead: 12.35, applyStyle: false })
    expect(body.history).toHaveLength(8)
    expect(body.history[0]).toEqual({ from: 'user', text: 'turn 4' })
    expect(body.history.at(-1)).toEqual({ from: 'ai', text: 'turn 11' })
  })

  it('waits for the edits still being saved, because the assistant plans on the saved timeline', async () => {
    const order: string[] = []
    flush.mockImplementation(async () => void order.push('saved'))
    post.mockImplementation(async () => {
      order.push('asked')
      return { text: 'ok' }
    })
    await askAssistant(ctx(), 'hi')
    expect(order).toEqual(['saved', 'asked'])
  })

  it('keeps a long message to what the server reads', async () => {
    post.mockResolvedValue({ text: 'ok' })
    await askAssistant(ctx(), 'a'.repeat(1500))
    expect(post.mock.calls[0]![1].text).toHaveLength(1000)
  })

  it('sends a tapped answer with the card it belongs to', async () => {
    post.mockResolvedValue({ text: 'ok' })
    const q: QuestionCard = {
      id: 'q1',
      intent: 'reel|step=part',
      prompt: 'Which part?',
      options: [{ id: 'best', label: 'My best hook' }],
    }
    await answerAssistant(ctx(), q, 'best')
    expect(post.mock.calls[0]![0]).toBe('/projects/p1/assistant/answers')
    expect(post.mock.calls[0]![1]).toMatchObject({ question: q, optionId: 'best' })
  })

  it('asks for a Reel from a range, at the fast pace', async () => {
    post.mockResolvedValue({ text: 'ok' })
    await reelAssistant(ctx(), { srcFrom: 10, srcTo: 40, title: 'Funding' })
    expect(post.mock.calls[0]![0]).toBe('/projects/p1/assistant/reel')
    expect(post.mock.calls[0]![1]).toMatchObject({
      srcFrom: 10,
      srcTo: 40,
      title: 'Funding',
      fast: true,
    })
  })
})

describe('when the assistant cannot answer', () => {
  it('a failure is a short reply with no plan, never a thrown error', async () => {
    post.mockRejectedValue(new ApiError('boom', 503, undefined, 'UNAVAILABLE'))
    const res = await askAssistant(ctx({ lang: 'en' }), 'hi')
    expect(res.plan).toBeUndefined()
    expect(res.text).toMatch(/could not reach the assistant/)
  })

  it('says when the day’s requests are used up and when they come back', () => {
    const e = new ApiError('x', 429, undefined, 'RATE_LIMITED', {
      retryAfterSec: 7 * 3600,
      limit: 30,
      used: 30,
    })
    expect(failure(e, 'en').text).toMatch(/used today’s assistant requests.*7 hours/)
    expect(failure(e, 'hinglish').text).toMatch(/Aaj ki assistant requests.*7 ghante/)
    expect(failure(e, 'hi').text).toMatch(/7 घंटे/)
  })

  it('says to wait a moment after a burst, with the seconds', () => {
    const e = new ApiError('x', 429, undefined, 'RATE_LIMITED', {
      retryAfterSec: 38,
      window: 'minute',
    })
    expect(failure(e, 'en').text).toMatch(/a lot of requests.*38 seconds/)
  })
})
