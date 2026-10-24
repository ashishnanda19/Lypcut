import type {
  SceneSpan,
  Timeline,
  TimelineItem,
  TimelineSettings,
  Track,
} from "./types.js";

export const DEFAULT_SETTINGS: TimelineSettings = {
  captionStyleId: "saffron-pop",
  captionsOn: false,
  crop: { x: 0.5, y: 0.5, scale: 1 },
  keyframes: [],
  markers: [],
  aspect: "9:16",
};

/** The track layout the editor expects (video, B-roll, voice, captions, plus two advanced tracks). */
export const TRACKS: Track[] = [
  { id: "trk_video", kind: "video", name: "Video" },
  { id: "trk_broll", kind: "broll", name: "B-roll" },
  { id: "trk_audio", kind: "audio", name: "Voice" },
  { id: "trk_captions", kind: "captions", name: "Captions" },
  { id: "trk_overlay", kind: "broll", name: "Overlay", advanced: true },
  { id: "trk_effects", kind: "effects", name: "Effects", advanced: true },
];

/**
 * The timeline the editor opens with: one video clip and one voice clip per scene found. Captions start
 * empty on purpose ("Add captions" is the first thing the assistant offers). The B-roll track starts
 * empty too: the front end's mock invented four placeholder B-roll clips, but with no real footage
 * behind them a clip on that track would be a lie, so none are created.
 */
export function buildInitialTimeline(
  scenes: SceneSpan[],
  sourceDuration: number,
): Timeline {
  const items: Record<string, TimelineItem> = {};
  for (const s of scenes) {
    items[`v_${s.id}`] = {
      id: `v_${s.id}`,
      trackId: "trk_video",
      kind: "video",
      label: s.label,
      start: s.start,
      duration: s.end - s.start,
      srcIn: s.start,
    };
    items[`a_${s.id}`] = {
      id: `a_${s.id}`,
      trackId: "trk_audio",
      kind: "audio",
      label: "Voice",
      start: s.start,
      duration: s.end - s.start,
      srcIn: s.start,
    };
  }
  return {
    tracks: TRACKS.map((t) => ({ ...t })),
    items,
    settings: { ...DEFAULT_SETTINGS, keyframes: [], markers: [] },
    sourceDuration,
  };
}
