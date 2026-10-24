/**
 * The timeline model. The editor (frontend/src/types) re-exports these, so the server validates and stores
 * exactly what the editor shows.
 *
 * Two clocks exist and are never mixed up:
 *   - SOURCE time: seconds in the original upload. Transcript words live here.
 *   - TIMELINE time: seconds in the edited result. Clips, the playhead and exports live here.
 * A video item maps one to the other: sourceTime = item.srcIn + (timelineTime - item.start).
 *
 * This package has no HTTP, database or storage code, so the same validator checks ops the AI assistant
 * proposes through exactly the same gate as the user's own edits, in the browser and on the server.
 */

export type TrackKind = "video" | "broll" | "audio" | "captions" | "effects";
export type ItemKind = "video" | "broll" | "audio" | "caption" | "effect";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted?: boolean;
  locked?: boolean;
  /** Only shown in Advanced mode. */
  advanced?: boolean;
}

export interface ItemMeta {
  /** Caption text (Roman) and its Devanagari twin. */
  text?: string;
  dev?: string;
  /** Transcript word range for captions (from inclusive, to exclusive). */
  wordFrom?: number;
  wordTo?: number;
  effect?: "blur" | "zoom" | "shake";
  amount?: number;
  /** Created by the assistant. Drives the landing animation. */
  ai?: boolean;
}

export interface TimelineItem {
  id: string;
  trackId: string;
  kind: ItemKind;
  label: string;
  /** Position on the timeline, in seconds. */
  start: number;
  duration: number;
  /** Source time at `start`. Meaningful for video, audio and captions. */
  srcIn: number;
  meta?: ItemMeta;
}

export interface CropState {
  /** Centre of the 9:16 window inside the source frame, 0-1 on both axes. */
  x: number;
  y: number;
  /** 1 = the full-height 9:16 window, larger zooms in. */
  scale: number;
}

export interface Keyframe extends CropState {
  /** Timeline time. */
  t: number;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
}

export type AspectId = "9:16" | "1:1" | "4:5" | "16:9";

export interface TimelineSettings {
  captionStyleId: string;
  captionsOn: boolean;
  crop: CropState;
  keyframes: Keyframe[];
  markers: Marker[];
  aspect: AspectId;
  /** Overrides for the chosen caption style. Unset means the preset's own look. */
  captionFont?: string;
  captionAccent?: string;
}

export interface Timeline {
  tracks: Track[];
  items: Record<string, TimelineItem>;
  settings: TimelineSettings;
  /** Length of the original upload in seconds. Trims never reach past it. */
  sourceDuration: number;
}

/**
 * Every change to a timeline is a TimelineOp. The assistant never touches video directly: it
 * proposes ops, and they pass through the same validator as the user's edits.
 */
export type TimelineOp =
  | { type: "trim"; itemId: string; edge: "start" | "end"; to: number }
  | { type: "split"; itemId: string; at: number; newId?: string }
  | { type: "move"; itemId: string; start: number; trackId?: string }
  | { type: "delete"; itemIds: string[] }
  | { type: "rippleDelete"; from: number; to: number; trackIds?: string[] }
  | { type: "cutSource"; srcFrom: number; srcTo: number }
  | {
      type: "restoreSource";
      srcFrom: number;
      srcTo: number;
      captions?: TimelineItem[];
    }
  | { type: "addCaptions"; items: TimelineItem[]; replace?: boolean }
  | { type: "addEffect"; item: TimelineItem }
  | { type: "setCrop"; crop: CropState; keyframes?: Keyframe[] }
  | { type: "setCaptionStyle"; styleId: string }
  | { type: "setSettings"; patch: Partial<TimelineSettings> }
  | { type: "addMarker"; marker: Marker }
  | { type: "removeMarker"; id: string }
  | {
      type: "patch";
      upsert: TimelineItem[];
      remove: string[];
      settings?: Partial<TimelineSettings>;
    }
  | { type: "batch"; ops: TimelineOp[]; label?: string };

/** A scene as the timeline builder needs it. */
export interface SceneSpan {
  id: string;
  label: string;
  start: number;
  end: number;
}

/** A transcript word as the transcript-to-ops builders read it. Richer rows (with confidence, a search key) fit too. */
export interface Word {
  /** Roman (Hinglish) spelling. English words keep their English spelling. */
  text: string;
  /** Devanagari spelling, shown in Devanagari mode. */
  dev: string;
  start: number;
  end: number;
  speaker: string;
  /** Language of this single word, so mixed sentences render correctly. */
  language: "hi" | "en";
  filler?: boolean;
}
