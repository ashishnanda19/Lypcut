/**
 * Lypcut data model. Everything the UI and the (future) backend agree on lives here.
 *
 * Two clocks exist and are never mixed up:
 *   - SOURCE time: seconds in the original upload. Transcript words live here.
 *   - TIMELINE time: seconds in the edited result. Clips, the playhead and exports live here.
 * A video item maps one to the other: sourceTime = item.srcIn + (timelineTime - item.start).
 */

import type {
  AspectId,
  CropState,
  ItemKind,
  ItemMeta,
  Keyframe,
  Marker,
  Timeline,
  TimelineItem,
  TimelineOp,
  TimelineSettings,
  Track,
  TrackKind,
  Word,
} from '@lypcut/timeline-core'

/**
 * The timeline model and its ops live in @lypcut/timeline-core, shared with the server, so the editor and the
 * backend can never disagree about what a timeline is. They are re-exported here for the rest of the app.
 */
export type {
  AspectId,
  CropState,
  ItemKind,
  ItemMeta,
  Keyframe,
  Marker,
  Timeline,
  TimelineItem,
  TimelineOp,
  TimelineSettings,
  Track,
  TrackKind,
  Word,
}

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
  /** The Edit card this version takes back (an AI edit undone out of order), if any. */
  undoesEditId?: string
  /** The server's number for this version once it has saved it. Unset in the mock, and until the save lands. */
  serverN?: number
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
  /** A short-lived link to the Reel's picture. Absent in mock mode and while there is none: show the placeholder from `thumbSeed`. */
  thumbUrl?: string
  /** A number that is not known is null, never 0: Instagram did not say, or the person did not type it. */
  views: number | null
  likes: number | null
  saves: number | null
  shares: number | null
  comments?: number | null
  avgWatchPct: number | null
  durationSec: number
  postedAt: string
  /** 0-100 against the person's other Reels. Null when there are no numbers to score. */
  engagement?: number | null
  source?: 'instagram' | 'upload'
}

export interface StyleProfile {
  connected: boolean
  source: 'instagram' | 'upload' | null
  handle?: string
  reelsAnalysed: number
  hookTimingSec: number
  /** Cuts per 10 seconds. */
  cutPace: number
  /** Share of reels per caption style id. `custom` is captions the editor has no look for. */
  captionStyles: { id: string; share: number }[]
  /** Not learned in this version: always empty from the real backend. */
  music: { label: string; share: number }[]
  /** Average first-3-seconds retention for the last 8 reels, 0-100. Empty unless Instagram supplied it. */
  hookRetention: number[]
  fonts: string[]
  colors: string[]
  /** How sure the profile is, from how many Reels it is learned from. Absent in mock mode. */
  confidence?: 'low' | 'medium' | 'high'
  updatedAt?: string | null
  /** One sentence about the style, in the person's language. */
  summary?: string
}

export type StyleState = 'idle' | 'syncing' | 'analysing' | 'ready' | 'reauth_required' | 'failed'

/** Where style learning is. Only the real backend has one. */
export interface StyleStatus {
  state: StyleState
  progress: number
  reels: { total: number; analysed: number; analysing: number; pending: number; failed: number }
  failed: { id: string; label: string; code: string; message: string }[]
  updatedAt: string | null
  /** `reel_files`: Instagram is connected but there is no video to learn the style from yet. */
  needs: 'reel_files' | null
}

/** What the server says before the person is sent to Instagram. */
export interface InstagramStart {
  authUrl: string
  consent: { reads: string[]; uses: string; never: string[]; disconnect: string }
  scopes: string[]
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
