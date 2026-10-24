import type { Scene, Timeline, TimelineItem } from '@/types'
import { DEFAULT_SETTINGS, TRACKS } from '@lypcut/timeline-core'

/**
 * The timeline the demo (mock) editor opens with: one video clip and one voice clip per scene the AI found,
 * plus a few B-roll suggestions that only the demo makes up. The real backend builds its own
 * (without B-roll) when processing finishes, with the same builder the server uses (@lypcut/timeline-core). Captions start empty on purpose: "Add captions" is the first
 * thing the assistant offers, and watching them land is the point.
 */
export function buildInitialTimeline(scenes: Scene[], sourceDuration: number): Timeline {
  const items: Record<string, TimelineItem> = {}
  for (const s of scenes) {
    items[`v_${s.id}`] = {
      id: `v_${s.id}`,
      trackId: 'trk_video',
      kind: 'video',
      label: s.label,
      start: s.start,
      duration: s.end - s.start,
      srcIn: s.start,
    }
    items[`a_${s.id}`] = {
      id: `a_${s.id}`,
      trackId: 'trk_audio',
      kind: 'audio',
      label: 'Voice',
      start: s.start,
      duration: s.end - s.start,
      srcIn: s.start,
    }
  }
  const labels = ['Office shot', 'Chart overlay', 'Handshake', 'City skyline']
  const spots = [0.18, 0.4, 0.62, 0.82]
  spots.forEach((p, i) => {
    const start = Math.round(sourceDuration * p)
    items[`b_${i}`] = {
      id: `b_${i}`,
      trackId: 'trk_broll',
      kind: 'broll',
      label: labels[i]!,
      start,
      duration: 6 + (i % 2) * 2,
      srcIn: 0,
    }
  })
  return { tracks: TRACKS, items, settings: { ...DEFAULT_SETTINGS }, sourceDuration }
}

/** A deliberately heavy timeline for performance checks: 300 clips, plus captions. */
export function buildStressTimeline(sourceDuration = 3600, clips = 300): Timeline {
  const items: Record<string, TimelineItem> = {}
  const step = sourceDuration / clips
  for (let i = 0; i < clips; i++) {
    const start = i * step
    const dur = step * 0.92
    items[`sv_${i}`] = {
      id: `sv_${i}`,
      trackId: 'trk_video',
      kind: 'video',
      label: `Clip ${i + 1}`,
      start,
      duration: dur,
      srcIn: start,
    }
    items[`sa_${i}`] = {
      id: `sa_${i}`,
      trackId: 'trk_audio',
      kind: 'audio',
      label: 'Voice',
      start,
      duration: dur,
      srcIn: start,
    }
    if (i % 2 === 0) {
      items[`sc_${i}`] = {
        id: `sc_${i}`,
        trackId: 'trk_captions',
        kind: 'caption',
        label: `Caption ${i + 1}`,
        start: start + 0.5,
        duration: Math.min(dur - 1, 6),
        srcIn: start + 0.5,
        meta: { text: `Caption ${i + 1}`, dev: `कैप्शन ${i + 1}` },
      }
    }
  }
  return {
    tracks: TRACKS,
    items,
    settings: { ...DEFAULT_SETTINGS, captionsOn: true },
    sourceDuration,
  }
}
