import type { Timeline, TimelineItem } from '@/types'
import { trackItems } from './queries'

/**
 * Writes the timeline as OpenTimelineIO JSON, the interchange format that DaVinci Resolve,
 * Premiere Pro (via adapters) and Final Cut Pro (via FCPXML conversion) can read.
 * This is a faithful structural export of what the user sees: clips, gaps, source ranges.
 */

const RATE = 30

interface Otio {
  OTIO_SCHEMA: string
  [k: string]: unknown
}

const rt = (sec: number): Otio => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate: RATE,
  value: Math.round(sec * RATE * 1000) / 1000,
})

const range = (start: number, duration: number): Otio => ({
  OTIO_SCHEMA: 'TimeRange.1',
  duration: rt(duration),
  start_time: rt(start),
})

function gap(duration: number): Otio {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name: '',
    source_range: range(0, duration),
    effects: [],
    markers: [],
    metadata: {},
  }
}

function clip(it: TimelineItem, mediaUrl: string, sourceDuration: number): Otio {
  const generated = it.kind === 'caption' || it.kind === 'effect'
  return {
    OTIO_SCHEMA: 'Clip.2',
    name: it.label,
    source_range: range(generated ? 0 : it.srcIn, it.duration),
    media_reference: generated
      ? {
          OTIO_SCHEMA: 'GeneratorReference.1',
          name: it.kind,
          generator_kind:
            it.kind === 'caption' ? 'lypcut.caption' : `lypcut.effect.${it.meta?.effect ?? 'blur'}`,
          parameters: {
            text: it.meta?.text ?? '',
            dev: it.meta?.dev ?? '',
            amount: it.meta?.amount ?? 0,
          },
          available_range: null,
          metadata: {},
        }
      : {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: 'source',
          target_url: mediaUrl,
          available_range: range(0, sourceDuration),
          metadata: {},
        },
    effects: [],
    markers: [],
    metadata: { lypcut: { id: it.id, ai: it.meta?.ai ?? false } },
  }
}

function track(
  tl: Timeline,
  trackId: string,
  name: string,
  kind: 'Video' | 'Audio',
  mediaUrl: string,
): Otio {
  const children: Otio[] = []
  let cursor = 0
  for (const it of trackItems(tl, trackId)) {
    if (it.start - cursor > 1 / RATE) children.push(gap(it.start - cursor))
    children.push(clip(it, mediaUrl, tl.sourceDuration))
    cursor = it.start + it.duration
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name,
    kind,
    source_range: null,
    children,
    effects: [],
    markers: [],
    metadata: {},
  }
}

export function toOtio(tl: Timeline, name: string, mediaUrl = 'media/source.mp4'): Otio {
  const kinds: Record<string, 'Video' | 'Audio'> = { audio: 'Audio' }
  const tracks = tl.tracks
    .filter((t) => trackItems(tl, t.id).length > 0)
    .map((t) => track(tl, t.id, t.name, kinds[t.kind] ?? 'Video', mediaUrl))
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      source_range: null,
      children: tracks,
      effects: [],
      markers: tl.settings.markers.map((m) => ({
        OTIO_SCHEMA: 'Marker.2',
        name: m.label,
        color: 'ORANGE',
        marked_range: range(m.time, 0),
        metadata: {},
      })),
      metadata: {},
    },
    metadata: { lypcut: { aspect: tl.settings.aspect, captionStyle: tl.settings.captionStyleId } },
  }
}

export function otioString(tl: Timeline, name: string): string {
  return JSON.stringify(toOtio(tl, name), null, 2)
}
