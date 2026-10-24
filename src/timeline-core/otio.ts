import { OpError } from './ops.js'
import { trackItems } from './queries.js'
import type { Timeline, TimelineItem, TimelineSettings, Track } from './types.js'

/**
 * OpenTimelineIO, the interchange format DaVinci Resolve, Premiere Pro (through adapters) and Final Cut Pro
 * (through FCPXML conversion) can read. This is a faithful structural export of what the editor shows: clips,
 * gaps, source ranges, markers. Ported from the front end (src/lib/timeline/otio.ts).
 *
 * Beyond what the front end writes, everything Lypcut needs to read its own file back exactly (ids, exact
 * times, empty tracks, the full settings) is stored under each node's `metadata.lypcut`. OTIO tools ignore
 * unknown metadata, so the file stays a normal OTIO file, and `fromOtio` can rebuild the timeline with nothing lost.
 * Times in the OTIO structure itself are frames at 30 fps, as editors expect.
 */

export const RATE = 30
/** Bumped when what `metadata.lypcut` holds changes shape. */
const LYPCUT_VERSION = 1

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
    metadata: {
      lypcut: {
        id: it.id,
        ai: it.meta?.ai ?? false,
        kind: it.kind,
        // Exact values: the OTIO ranges above are rounded to a frame fraction, and a gap shorter than a
        // frame is not written at all, so these are what make a re-import exact.
        start: it.start,
        duration: it.duration,
        srcIn: it.srcIn,
        ...(it.meta ? { meta: it.meta } : {}),
      },
    },
  }
}

function track(tl: Timeline, t: Track, kind: 'Video' | 'Audio', mediaUrl: string): Otio {
  const children: Otio[] = []
  let cursor = 0
  for (const it of trackItems(tl, t.id)) {
    if (it.start - cursor > 1 / RATE) children.push(gap(it.start - cursor))
    children.push(clip(it, mediaUrl, tl.sourceDuration))
    cursor = it.start + it.duration
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name: t.name,
    kind,
    source_range: null,
    children,
    effects: [],
    markers: [],
    metadata: { lypcut: { track: t } },
  }
}

export function toOtio(tl: Timeline, name: string, mediaUrl = 'media/source.mp4'): Otio {
  const kinds: Record<string, 'Video' | 'Audio'> = { audio: 'Audio' }
  // Only tracks with something on them become OTIO tracks (an empty one would just be noise in an NLE);
  // the full list, empty tracks included, is kept in the metadata.
  const tracks = tl.tracks
    .filter((t) => trackItems(tl, t.id).length > 0)
    .map((t) => track(tl, t, kinds[t.kind] ?? 'Video', mediaUrl))
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
        metadata: { lypcut: { id: m.id, time: m.time } },
      })),
      metadata: {},
    },
    metadata: {
      lypcut: {
        version: LYPCUT_VERSION,
        aspect: tl.settings.aspect,
        captionStyle: tl.settings.captionStyleId,
        sourceDuration: tl.sourceDuration,
        tracks: tl.tracks,
        settings: tl.settings,
      },
    },
  }
}

export function otioString(tl: Timeline, name: string, mediaUrl?: string): string {
  return JSON.stringify(toOtio(tl, name, mediaUrl), null, 2)
}

/* ------------------------------------------------------------------ */
/* Reading a Lypcut OTIO file back                                      */
/* ------------------------------------------------------------------ */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const notLypcut = () => new OpError('That file was not made by Lypcut, so it cannot be read back.')

/**
 * The inverse of `toOtio` for files Lypcut wrote. It reads the exact values from `metadata.lypcut`, so what
 * comes back equals what went in. A plain OTIO file from another tool (no Lypcut metadata) is refused with
 * a clear message rather than guessed at.
 */
export function fromOtio(otio: unknown): { name: string; timeline: Timeline } {
  if (!isObject(otio) || otio.OTIO_SCHEMA !== 'Timeline.1') throw notLypcut()
  const meta =
    isObject(otio.metadata) && isObject(otio.metadata.lypcut) ? otio.metadata.lypcut : null
  if (!meta || meta.version !== LYPCUT_VERSION) throw notLypcut()
  if (
    !Array.isArray(meta.tracks) ||
    !isObject(meta.settings) ||
    typeof meta.sourceDuration !== 'number'
  ) {
    throw notLypcut()
  }

  const stack = otio.tracks
  if (!isObject(stack) || !Array.isArray(stack.children)) throw notLypcut()

  const items: Record<string, TimelineItem> = {}
  for (const trackNode of stack.children) {
    const trackMeta =
      isObject(trackNode) && isObject(trackNode.metadata) ? trackNode.metadata.lypcut : null
    const t = isObject(trackMeta) ? (trackMeta.track as Track | undefined) : undefined
    if (!isObject(trackNode) || !t || !Array.isArray(trackNode.children)) throw notLypcut()
    for (const child of trackNode.children) {
      if (!isObject(child) || child.OTIO_SCHEMA !== 'Clip.2') continue // a Gap
      const m = isObject(child.metadata) ? child.metadata.lypcut : null
      if (!isObject(m) || typeof m.id !== 'string') throw notLypcut()
      const item: TimelineItem = {
        id: m.id,
        trackId: t.id,
        kind: m.kind as TimelineItem['kind'],
        label: String(child.name ?? ''),
        start: Number(m.start),
        duration: Number(m.duration),
        srcIn: Number(m.srcIn),
        ...(isObject(m.meta) ? { meta: m.meta as TimelineItem['meta'] } : {}),
      }
      items[item.id] = item
    }
  }

  return {
    name: String(otio.name ?? ''),
    timeline: {
      tracks: meta.tracks as Track[],
      items,
      settings: meta.settings as unknown as TimelineSettings,
      sourceDuration: meta.sourceDuration,
    },
  }
}
