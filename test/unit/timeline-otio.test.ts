import { describe, expect, it } from 'vitest'
import { sameTimeline } from '../../src/timeline-core/equality.js'
import { applyOp, OpError, sequentialIds } from '../../src/timeline-core/ops.js'
import { fromOtio, otioString, RATE, toOtio } from '../../src/timeline-core/otio.js'
import { timelineDuration, trackItems } from '../../src/timeline-core/queries.js'
import type { Timeline, TimelineOp } from '../../src/timeline-core/types.js'
import { captionItems, clone, prng, sampleTimeline } from '../helpers/timeline.js'

type Node = {
  OTIO_SCHEMA: string
  children?: Node[]
  kind?: string
  name?: string
  source_range?: { duration: { value: number; rate: number }; start_time: { value: number } }
  media_reference?: {
    OTIO_SCHEMA: string
    target_url?: string
    generator_kind?: string
    parameters?: Record<string, unknown>
  }
  metadata?: { lypcut?: Record<string, unknown> }
}
type Doc = {
  OTIO_SCHEMA: string
  name: string
  tracks: Node & { markers: Node[] }
  metadata: { lypcut: Record<string, unknown> }
}

const { timeline: base } = sampleTimeline()

/** A timeline with captions, an effect, a marker, a cut, a trim and a changed crop: every kind of thing an export can hold. */
function richTimeline(): Timeline {
  const ops: TimelineOp[] = [
    { type: 'cutSource', srcFrom: 40, srcTo: 52 },
    { type: 'addCaptions', items: captionItems(0, 30) },
    {
      type: 'addEffect',
      item: {
        id: 'fx1',
        trackId: 'trk_effects',
        kind: 'effect',
        label: 'Zoom',
        start: 5,
        duration: 3,
        srcIn: 0,
        meta: { effect: 'zoom', amount: 0.5 },
      },
    },
    { type: 'addMarker', marker: { id: 'm1', time: 12.5, label: 'Hook' } },
    {
      type: 'setCrop',
      crop: { x: 0.7, y: 0.4, scale: 1.6 },
      keyframes: [
        { t: 0, x: 0.5, y: 0.5, scale: 1 },
        { t: 9, x: 0.7, y: 0.4, scale: 1.6 },
      ],
    },
    {
      type: 'setSettings',
      patch: { captionFont: 'Inter', captionAccent: '#ffa83a', aspect: '4:5' },
    },
    { type: 'move', itemId: 'b_0', start: 3 },
  ]
  const ids = sequentialIds('r_')
  return ops.reduce((tl, op) => applyOp(tl, op, { newId: ids }).timeline, base)
}

describe('OpenTimelineIO export', () => {
  const edited = richTimeline()
  const otio = toOtio(edited, 'Funding kaise raise karein') as unknown as Doc

  it('is a valid Timeline.1 with a Stack of tracks', () => {
    expect(otio.OTIO_SCHEMA).toBe('Timeline.1')
    expect(otio.name).toBe('Funding kaise raise karein')
    expect(otio.tracks.OTIO_SCHEMA).toBe('Stack.1')
    const kinds = otio.tracks.children!.map((t) => t.kind)
    expect(kinds).toContain('Video')
    expect(kinds).toContain('Audio')
    for (const t of otio.tracks.children!) expect(t.OTIO_SCHEMA).toBe('Track.1')
  })

  it('every node carries an OTIO_SCHEMA, as a reader requires', () => {
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if ('children' in o || 'media_reference' in o || 'marked_range' in o) {
          expect(typeof o.OTIO_SCHEMA, JSON.stringify(o).slice(0, 80)).toBe('string')
        }
        Object.values(o).forEach(walk)
      }
    }
    walk(otio)
  })

  it('writes clips with source ranges and external media, in frames at 30 fps', () => {
    const video = otio.tracks.children!.find((t) => t.name === 'Video')!
    const clips = video.children!.filter((c) => c.OTIO_SCHEMA === 'Clip.2')
    expect(clips.length).toBeGreaterThan(5)
    for (const c of clips) {
      expect(c.source_range!.duration.rate).toBe(RATE)
      expect(c.media_reference!.OTIO_SCHEMA).toBe('ExternalReference.1')
      expect(c.media_reference!.target_url).toBe('media/source.mp4')
    }
    const total = clips.reduce((s, c) => s + c.source_range!.duration.value, 0)
    expect(total / RATE).toBeCloseTo(timelineDuration(edited) - 0, 0)
  })

  it('writes captions and effects as generators, not as media', () => {
    const caps = otio.tracks.children!.find((t) => t.name === 'Captions')!
    const first = caps.children!.find((c) => c.OTIO_SCHEMA === 'Clip.2')!
    expect(first.media_reference).toMatchObject({
      OTIO_SCHEMA: 'GeneratorReference.1',
      generator_kind: 'lypcut.caption',
    })
    expect(first.media_reference!.parameters).toMatchObject({ text: 'word 0', dev: 'शब्द 0' })
    const fx = otio.tracks.children!.find((t) => t.name === 'Effects')!
    expect(
      fx.children!.find((c) => c.OTIO_SCHEMA === 'Clip.2')!.media_reference!.generator_kind,
    ).toBe('lypcut.effect.zoom')
  })

  it('puts a gap where a track has empty space', () => {
    const video = otio.tracks.children!.find((t) => t.name === 'B-roll')!
    // b_0 was moved to 3 s, so the track starts with a 3 s gap.
    expect(video.children![0]!.OTIO_SCHEMA).toBe('Gap.1')
    expect(video.children![0]!.source_range!.duration.value / RATE).toBeCloseTo(3, 1)
  })

  it('writes markers on the stack', () => {
    expect(otio.tracks.markers).toHaveLength(1)
    expect(otio.tracks.markers[0]).toMatchObject({ OTIO_SCHEMA: 'Marker.2', name: 'Hook' })
  })

  it('leaves out tracks that have nothing on them, so an editor is not given empty ones', () => {
    const names = otio.tracks.children!.map((t) => t.name)
    expect(names).not.toContain('Overlay')
  })

  it('is plain JSON that survives a text round trip', () => {
    expect(JSON.parse(JSON.stringify(otio))).toEqual(otio)
    expect(JSON.parse(otioString(edited, 'x'))).toMatchObject({ OTIO_SCHEMA: 'Timeline.1' })
  })

  it('names the media file it points at, and lets the caller choose', () => {
    const other = toOtio(edited, 'x', 'footage/original.mov') as unknown as Doc
    const clip = other.tracks
      .children!.find((t) => t.name === 'Video')!
      .children!.find((c) => c.OTIO_SCHEMA === 'Clip.2')!
    expect(clip.media_reference!.target_url).toBe('footage/original.mov')
  })

  it('reflects the edit: a cut makes the export shorter by exactly that much', () => {
    const before = timelineDuration(base)
    const after = timelineDuration(edited)
    expect(before - after).toBeCloseTo(12, 1)
    const frames = (doc: Doc) =>
      doc.tracks
        .children!.find((t) => t.name === 'Video')!
        .children!.filter((c) => c.OTIO_SCHEMA === 'Clip.2')
        .reduce((s, c) => s + c.source_range!.duration.value, 0)
    expect((frames(toOtio(base, 'a') as unknown as Doc) - frames(otio)) / RATE).toBeCloseTo(12, 0)
  })
})

describe('round trip: what Lypcut writes, it reads back exactly', () => {
  const roundTrip = (tl: Timeline, name = 'My project') =>
    fromOtio(JSON.parse(JSON.stringify(toOtio(tl, name))))

  it('an untouched timeline', () => {
    const { timeline, name } = roundTrip(base, 'Funding')
    expect(name).toBe('Funding')
    expect(sameTimeline(timeline, base)).toBe(true)
  })

  it('a timeline with captions, an effect, a marker, a cut, keyframes and changed settings', () => {
    const tl = richTimeline()
    expect(sameTimeline(roundTrip(tl).timeline, tl)).toBe(true)
  })

  it('keeps empty tracks and the track order, even though they are not written as OTIO tracks', () => {
    const { timeline } = roundTrip(base)
    expect(timeline.tracks.map((t) => t.id)).toEqual(base.tracks.map((t) => t.id))
  })

  it('keeps a locked, muted or advanced track as it was', () => {
    const tl: Timeline = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.id === 'trk_video' ? { ...t, locked: true, muted: true } : t,
      ),
    }
    expect(roundTrip(tl).timeline.tracks.find((t) => t.id === 'trk_video')).toMatchObject({
      locked: true,
      muted: true,
    })
  })

  it('keeps exact times, which the frame-rounded OTIO ranges cannot', () => {
    // Build a new items object: the engine never mutates, so query caches key on its identity.
    const v = trackItems(base, 'trk_video')[0]!
    const tl: Timeline = {
      ...base,
      items: {
        ...base.items,
        [v.id]: { ...v, start: 0.123456789, duration: 3.987654321, srcIn: 0.123456789 },
      },
    }
    const back = roundTrip(tl).timeline.items[v.id]!
    expect(back.start).toBe(0.123456789)
    expect(back.duration).toBe(3.987654321)
  })

  it('keeps clips that sit less than a frame apart, where OTIO would write no gap', () => {
    const [a, b] = trackItems(base, 'trk_video')
    const tl: Timeline = {
      ...base,
      items: { ...base.items, [b!.id]: { ...b!, start: a!.start + a!.duration + 0.01 } },
    }
    expect(roundTrip(tl).timeline.items[b!.id]!.start).toBe(a!.start + a!.duration + 0.01)
  })

  it('keeps Devanagari captions and every caption field', () => {
    const tl = applyOp(base, { type: 'addCaptions', items: captionItems(0, 5) }).timeline
    const back = roundTrip(tl).timeline
    expect(back.items.c3!.meta).toEqual({ text: 'word 3', dev: 'शब्द 3', wordFrom: 6, wordTo: 8 })
  })

  for (const seed of [21, 22, 23, 24, 25]) {
    it(`survives a random edit history (seed ${seed})`, () => {
      const rand = prng(seed)
      const ids = sequentialIds(`o${seed}_`)
      let tl = base
      for (let i = 0; i < 60; i++) {
        const items = Object.values(tl.items)
        const clip =
          items.filter((x) => x.kind === 'video')[
            Math.floor(rand() * items.filter((x) => x.kind === 'video').length)
          ] ?? items[0]!
        const dur = timelineDuration(tl) || 1
        const ops: TimelineOp[] = [
          { type: 'split', itemId: clip.id, at: clip.start + clip.duration * (0.2 + rand() * 0.6) },
          { type: 'trim', itemId: clip.id, edge: 'end', to: clip.start + clip.duration * rand() },
          { type: 'rippleDelete', from: rand() * dur * 0.8, to: rand() * dur * 0.8 + 3 },
          { type: 'cutSource', srcFrom: rand() * 250, srcTo: rand() * 250 + 4 },
          { type: 'addMarker', marker: { id: `mk${i}`, time: rand() * dur, label: 'm' } },
          { type: 'setCrop', crop: { x: rand(), y: rand(), scale: 1 + rand() * 3 } },
        ]
        try {
          tl = applyOp(tl, ops[Math.floor(rand() * ops.length)]!, { newId: ids }).timeline
        } catch (e) {
          if (!(e instanceof OpError)) throw e
        }
      }
      expect(sameTimeline(roundTrip(tl).timeline, tl)).toBe(true)
    })
  }

  it('refuses an OTIO file that Lypcut did not write, plainly', () => {
    const plain = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'x',
      tracks: { OTIO_SCHEMA: 'Stack.1', children: [] },
      metadata: {},
    }
    expect(() => fromOtio(plain)).toThrow(OpError)
    expect(() => fromOtio(plain)).toThrow(/not made by Lypcut/)
    for (const junk of [null, 5, 'x', [], {}, { OTIO_SCHEMA: 'Clip.2' }])
      expect(() => fromOtio(junk)).toThrow(OpError)
    const wrongVersion = clone(toOtio(base, 'x')) as unknown as Doc
    wrongVersion.metadata.lypcut.version = 99
    expect(() => fromOtio(wrongVersion)).toThrow(OpError)
    const damaged = clone(toOtio(base, 'x')) as unknown as Doc
    delete (damaged.tracks.children![0] as Node).children
    expect(() => fromOtio(damaged)).toThrow(OpError)
  })
})
