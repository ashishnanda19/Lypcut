import { readDataBlock } from '../../llm/data-block.js'
import type { FakeHandler } from '../../llm/index.js'
import { templateSummary, type SummaryFacts } from './summary.js'
import { LABEL_CAPTIONS, WRITE_SUMMARY } from './tools.js'

/**
 * The offline model for style work. It cannot see pictures, so it labels every Reel `custom` rather than guess, and it writes
 * the summary from the same template the real model is asked to follow.
 */
export const fakeStyle: FakeHandler = (req) => {
  if (req.tools?.some((t) => t.name === WRITE_SUMMARY.name)) {
    const facts = readDataBlock<SummaryFacts>(req.context)
    return {
      text: '',
      toolCall: {
        id: 'fake-summary',
        name: WRITE_SUMMARY.name,
        input: {
          sentence: facts ? templateSummary(facts) : 'Your best Reels start quickly and cut often.',
        },
      },
    }
  }
  const data = readDataBlock<{ videos: Array<{ id: string }> }>(req.context)
  return {
    text: '',
    toolCall: {
      id: 'fake-captions',
      name: LABEL_CAPTIONS.name,
      input: {
        items: (data?.videos ?? []).map((v) => ({ id: v.id, style: 'custom', font: 'unknown' })),
      },
    },
  }
}
