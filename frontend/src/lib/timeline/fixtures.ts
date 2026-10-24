import { generateSource } from '@/mocks/data/seed'
import { buildInitialTimeline } from './build'

/** Shared test fixture: the sample project's source plus its opening timeline. */
export function fixture() {
  const src = generateSource('p_funding', 0, 56)
  const timeline = buildInitialTimeline(src.scenes, src.duration)
  return { src, words: src.transcript.words, timeline }
}
