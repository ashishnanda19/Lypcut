/**
 * Lypcut data model. Everything the UI and the (future) backend agree on lives here.
 *
 * Two clocks exist and are never mixed up:
 *   - SOURCE time: seconds in the original upload. Transcript words live here.
 *   - TIMELINE time: seconds in the edited result. Clips, the playhead and exports live here.
 * A video item maps one to the other: sourceTime = item.srcIn + (timelineTime - item.start).
 */

export type Lang = 'hi' | 'hinglish' | 'en'
export type ContentType = 'youtuber' | 'business' | 'clipper'
export type ProjectStatus = 'uploading' | 'processing' | 'ready' | 'exported' | 'failed'

/* ------------------------------------------------------------------ */
/* Projects and assets                                                  */
/* ------------------------------------------------------------------ */

export interface Asset {
  id: string
  kind: 'raw' | 'clip' | 'proxy'
  label: string
  durationSec: number
  /** Proxy video URL. In the mock a short looping stand-in clip is used for every project. */
  url?: string
}

export interface Project {
  id: string
  title: string
  status: ProjectStatus
  durationSec: number
  language: Lang
  /** Seed for the generated placeholder thumbnail. */
  thumbSeed: string
  createdAt: string
  updatedAt: string
  /** 0-100 while uploading or processing. */
  progress?: number
  /** Present while a processing job runs. */
  jobId?: string
  hooksFound?: number
  assets: Asset[]
}

export interface Speaker {
  id: string
  name: string
  color: 'saffron' | 'teal'
}

export interface Word {
  /** Roman (Hinglish) spelling. English words keep their English spelling. */
  text: string
  /** Devanagari spelling, shown in Devanagari mode. */
  dev: string
  start: number
  end: number
  speaker: string
  /** Language of this single word, so mixed sentences render correctly. */
  language: 'hi' | 'en'
  filler?: boolean
}

export interface Sentence {
  id: string
  speaker: string
  /** Index of the first word (inclusive) and one past the last word (exclusive). */
  from: number
  to: number
  start: number
  end: number
}

export interface Transcript {
  language: Lang
  speakers: Speaker[]
  words: Word[]
  sentences: Sentence[]
}

export interface Scene {
  id: string
  label: string
  start: number
  end: number
}

export interface Highlight {
  id: string
  title: string
  start: number
  end: number
  /** 0-100. How likely the opening is to stop a scroll. */
  hookScore: number
  /** One line explaining why this moment was picked. */
  reason: string
  thumbSeed: string
}

export interface Chapter {
  id: string
  title: string
  start: number
  end: number
}

export interface SearchResult {
  id: string
  start: number
  end: number
  /** 0-100. */
  relevance: number
  /** Word indices (into transcript.words) that matched the query. */
  matched: number[]
  /** Word range of the matched sentence window. */
  from: number
  to: number
  thumbSeed: string
}

/* ------------------------------------------------------------------ */
/* Timeline                                                              */
/* ------------------------------------------------------------------ */

export type TrackKind = 'video' | 'broll' | 'audio' | 'captions' | 'effects'
export type ItemKind = 'video' | 'broll' | 'audio' | 'caption' | 'effect'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted?: boolean
  locked?: boolean
  /** Only shown in Advanced mode. */
  advanced?: boolean
}

export interface ItemMeta {
  /** Caption text (Roman) and its Devanagari twin. */
  text?: string
  dev?: string
  /** Transcript word range for captions (from inclusive, to exclusive). */
  wordFrom?: number
  wordTo?: number
  effect?: 'blur' | 'zoom' | 'shake'
  amount?: number
  /** Created by the assistant. Drives the landing animation. */
  ai?: boolean
}

export interface TimelineItem {
  id: string
  trackId: string
  kind: ItemKind
  label: string
  /** Position on the timeline, in seconds. */
  start: number
  duration: number
  /** Source time at `start`. Meaningful for video, audio and captions. */
  srcIn: number
  meta?: ItemMeta
}

export interface CropState {
  /** Centre of the 9:16 window inside the source frame, 0-1 on both axes. */
  x: number
  y: number
  /** 1 = the full-height 9:16 window, larger zooms in. */
  scale: number
}

export interface Keyframe extends CropState {
  /** Timeline time. */
  t: number
}

export interface Marker {
  id: string
  time: number
  label: string
}

export type AspectId = '9:16' | '1:1' | '4:5' | '16:9'

export interface TimelineSettings {
  captionStyleId: string
  captionsOn: boolean
  crop: CropState
  keyframes: Keyframe[]
  markers: Marker[]
  aspect: AspectId
  /** Overrides for the chosen caption style. Unset means the preset's own look. */
  captionFont?: string
  captionAccent?: string
}

export interface Timeline {
  tracks: Track[]
  items: Record<string, TimelineItem>
  settings: TimelineSettings
  /** Length of the original upload in seconds. Trims never reach past it. */
  sourceDuration: number
}

/**
 * Every change to a timeline is a TimelineOp. The assistant never touches video
 * directly: it returns ops, the UI validates them and applies them.
 * `applyOp` always produces a `patch` as the inverse, so any op can be undone.
 */
export type TimelineOp =
  | { type: 'trim'; itemId: string; edge: 'start' | 'end'; to: number }
  | { type: 'split'; itemId: string; at: number; newId?: string }
  | { type: 'move'; itemId: string; start: number; trackId?: string }
  | { type: 'delete'; itemIds: string[] }
  | { type: 'rippleDelete'; from: number; to: number; trackIds?: string[] }
  | { type: 'cutSource'; srcFrom: number; srcTo: number }
  | { type: 'restoreSource'; srcFrom: number; srcTo: number; captions?: TimelineItem[] }
  | { type: 'addCaptions'; items: TimelineItem[]; replace?: boolean }
  | { type: 'addEffect'; item: TimelineItem }
  | { type: 'setCrop'; crop: CropState; keyframes?: Keyframe[] }
  | { type: 'setCaptionStyle'; styleId: string }
  | { type: 'setSettings'; patch: Partial<TimelineSettings> }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'removeMarker'; id: string }
  | {
      type: 'patch'
      upsert: TimelineItem[]
      remove: string[]
      settings?: Partial<TimelineSettings>
    }
  | { type: 'batch'; ops: TimelineOp[]; label?: string }

/* ------------------------------------------------------------------ */
/* History and chat                                                      */
/* ------------------------------------------------------------------ */

export interface Version {
  id: string
  n: number
  author: 'you' | 'ai'
  label: string
  at: number
  op: TimelineOp
  inverse: TimelineOp
  after: Timeline
  /** The Edit card that produced this version, if any. */
  editId?: string
}

export interface EditStripSegment {
  kind: 'keep' | 'cut' | 'add'
  weight: number
}

export type EditStatus = 'proposed' | 'previewing' | 'applied' | 'undone'

export interface EditPlan {
  id: string
  title: string
  description: string
  op: TimelineOp
  strip: EditStripSegment[]
  summary: { label: string; value: string; tone?: 'neutral' | 'saffron' | 'teal' | 'coral' }[]
  /** Seconds the playhead should jump to when previewing. */
  focus?: number
}

export interface QuestionOption {
  id: string
  label: string
  hint?: string
}

export interface QuestionCard {
  id: string
  intent: string
  prompt: string
  options: QuestionOption[]
  /** Picked option id. */
  answer?: string
}

export interface ChatMessage {
  id: string
  from: 'ai' | 'user'
  text: string
  at: number
  /** Stream the text in (only for fresh AI messages). */
  fresh?: boolean
  question?: QuestionCard
  editId?: string
  /** Suggested follow-up chips shown under the message. */
  chips?: string[]
  /** A button that opens another page, for example the Style page. */
  link?: { label: string; to: string }
}

/* ------------------------------------------------------------------ */
/* Jobs, style, account                                                  */
/* ------------------------------------------------------------------ */

export type JobKind = 'processing' | 'export' | 'otio'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  id: string
  projectId?: string
  kind: JobKind
  status: JobStatus
  progress: number
  /** Index of the current processing step. */
  step?: number
  detail?: string
  error?: string
  /** Live findings shown while waiting. */
  found?: { language?: string; speakers?: number; scenes?: number; hooks?: number }
  resultUrl?: string
}

export interface ReelMetric {
  id: string
  title: string
  thumbSeed: string
  views: number
  likes: number
  saves: number
  shares: number
  avgWatchPct: number
  durationSec: number
  postedAt: string
}

export interface StyleProfile {
  connected: boolean
  source: 'instagram' | 'upload' | null
  handle?: string
  reelsAnalysed: number
  hookTimingSec: number
  /** Cuts per 10 seconds. */
  cutPace: number
  /** Share of reels per caption style id. */
  captionStyles: { id: string; share: number }[]
  /** Share of reels per music type. */
  music: { label: string; share: number }[]
  /** Average first-3-seconds retention for the last 8 reels, 0-100. */
  hookRetention: number[]
  fonts: string[]
  colors: string[]
}

export interface User {
  id: string
  name: string
  email: string
  language: Lang
  contentType: ContentType | null
  onboarded: boolean
  plan: 'free' | 'creator' | 'studio'
}

export interface BrandKit {
  fonts: { heading: string; body: string }
  colors: { primary: string; accent: string; text: string }
  logoName: string | null
}
