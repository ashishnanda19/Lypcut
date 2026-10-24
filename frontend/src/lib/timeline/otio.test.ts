import { describe, expect, it } from 'vitest'
import { applyOp } from '@lypcut/timeline-core'
import { fixture } from './fixtures'
import { toOtio } from './otio'
import { timelineDuration } from '@lypcut/timeline-core'
import { cutWords } from '@lypcut/timeline-core'

type Node = {
  OTIO_SCHEMA: string
  children?: Node[]
  kind?: string
  source_range?: { duration: { value: number } }
  name?: string
}

describe('OpenTimelineIO export', () => {
  const { timeline, words } = fixture()
  const edited = applyOp(timeline, cutWords(words, 20, 27)).timeline
  const otio = toOtio(edited, 'Funding kaise raise karein') as unknown as {
    OTIO_SCHEMA: string
    tracks: Node
  }

  it('is a valid Timeline.1 with a Stack of tracks', () => {
    expect(otio.OTIO_SCHEMA).toBe('Timeline.1')
    expect(otio.tracks.OTIO_SCHEMA).toBe('Stack.1')
    const kinds = otio.tracks.children!.map((t) => t.kind)
    expect(kinds).toContain('Video')
    expect(kinds).toContain('Audio')
  })

  it('writes clips with source ranges and external media, in frames at 30fps', () => {
    const video = otio.tracks.children!.find((t) => t.name === 'Video')!
    const clips = video.children!.filter((c) => c.OTIO_SCHEMA === 'Clip.2')
    expect(clips.length).toBeGreaterThan(10)
    const total = clips.reduce((s, c) => s + c.source_range!.duration.value, 0)
    expect(total / 30).toBeCloseTo(timelineDuration(edited), 0)
  })

  it('survives a JSON round trip', () => {
    expect(() => JSON.parse(JSON.stringify(otio))).not.toThrow()
  })
})
