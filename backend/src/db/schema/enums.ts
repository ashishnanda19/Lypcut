import { pgEnum } from 'drizzle-orm/pg-core'

/** Mirrors the front end's types in src/types/index.ts. */
export const langEnum = pgEnum('lang', ['hi', 'hinglish', 'en'])
export const wordLangEnum = pgEnum('word_lang', ['hi', 'en'])
export const contentTypeEnum = pgEnum('content_type', ['youtuber', 'business', 'clipper'])
export const planEnum = pgEnum('plan', ['free', 'creator', 'studio'])
export const projectStatusEnum = pgEnum('project_status', [
  'uploading',
  'processing',
  'ready',
  'exported',
  'failed',
])

export const assetKindEnum = pgEnum('asset_kind', [
  'raw',
  'scene_clip',
  'proxy',
  'export',
  'thumbnail',
  'audio',
])
export const assetStatusEnum = pgEnum('asset_status', ['pending', 'ready', 'failed'])

export const uploadStatusEnum = pgEnum('upload_status', [
  'initiated',
  'uploading',
  'completing',
  'completed',
  'aborted',
  'expired',
  'failed',
])

export const jobTypeEnum = pgEnum('job_type', [
  'processing',
  'export',
  'otio',
  'delete_project',
  'delete_account',
  'cleanup_uploads',
])
export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
])
export const stageStatusEnum = pgEnum('stage_status', [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
])

/** The front end calls these 'you' and 'ai'. */
export const versionAuthorEnum = pgEnum('version_author', ['user', 'assistant'])

export const usageKindEnum = pgEnum('usage_kind', ['upload', 'video_seconds', 'export'])

export const llmKindEnum = pgEnum('llm_kind', ['planner', 'highlights', 'chapters', 'embed'])
