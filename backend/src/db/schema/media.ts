import {
  type AnyPgColumn,
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { assetKindEnum, assetStatusEnum, uploadStatusEnum } from './enums.js'
import { createdAt, pk, timestamps } from './_helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const scenes = pgTable(
  'scenes',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Order within the project, starting at 0. */
    idx: integer().notNull(),
    label: text().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    /** FFmpeg's scene-change score at the cut that opened this scene (0-1). */
    score: real(),
    /** Seconds (source time) of representative frames. */
    keyframes: jsonb().$type<number[]>().notNull().default([]),
    thumbnailAssetId: uuid().references((): AnyPgColumn => assets.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('scenes_project_start_idx').on(t.projectId, t.startSec),
    uniqueIndex('scenes_project_idx_uq').on(t.projectId, t.idx),
    check('scenes_range', sql`${t.startSec} >= 0 and ${t.endSec} > ${t.startSec}`),
  ],
)

export const assets = pgTable(
  'assets',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: assetKindEnum().notNull(),
    status: assetStatusEnum().notNull().default('pending'),
    /** Where the bytes live. Keys are prefixed users/<user>/projects/<project>/ so deletes are by prefix. */
    storageKey: text().notNull(),
    label: text().notNull(),
    mimeType: text(),
    sizeBytes: bigint({ mode: 'number' }),
    durationSec: doublePrecision(),
    width: integer(),
    height: integer(),
    codec: text(),
    /** SHA-256 (hex) of the stored object, when known. */
    checksum: text(),
    /** The scene a scene_clip was cut from. */
    sceneId: uuid().references((): AnyPgColumn => scenes.id, { onDelete: 'set null' }),
    /** Raw ffprobe summary, kept for debugging and later features. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('assets_storage_key_uq').on(t.storageKey),
    index('assets_project_kind_idx').on(t.projectId, t.kind),
    index('assets_scene_idx').on(t.sceneId),
    check('assets_size_nonneg', sql`${t.sizeBytes} is null or ${t.sizeBytes} >= 0`),
  ],
)

/** State of one resumable multipart upload, so a client can come back and carry on. */
export const uploads = pgTable(
  'uploads',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    assetId: uuid()
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    fileName: text().notNull(),
    contentType: text().notNull(),
    /** Size the client declared. Checked against storage on completion. */
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    /** Length the browser read from the file, used only for an early limit check. Never trusted. */
    declaredDurationSec: doublePrecision(),
    storageKey: text().notNull(),
    /** The storage provider's multipart upload id. */
    s3UploadId: text().notNull(),
    partSize: integer().notNull(),
    totalParts: integer().notNull(),
    /** Parts storage has confirmed, refreshed from the provider when state is read. */
    partsReceived: jsonb()
      .$type<Array<{ partNumber: number; size: number; etag: string }>>()
      .notNull()
      .default([]),
    status: uploadStatusEnum().notNull().default('initiated'),
    /** SHA-256 the client supplied on completion, verified against what was stored. */
    checksum: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('uploads_user_status_idx').on(t.userId, t.status),
    index('uploads_project_idx').on(t.projectId),
    index('uploads_status_expires_idx').on(t.status, t.expiresAt),
    check('uploads_size_positive', sql`${t.sizeBytes} > 0`),
    check('uploads_parts_positive', sql`${t.totalParts} > 0 and ${t.partSize} > 0`),
  ],
)

export const highlights = pgTable(
  'highlights',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    idx: integer().notNull(),
    title: text().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    /** 0-100: how likely the opening is to stop a scroll. */
    hookScore: integer().notNull(),
    reason: text().notNull(),
    thumbSeed: text().notNull(),
    /** 'llm' (a real model scored it), 'offline' (the built-in model), or 'heuristic' (the cheap signals alone). */
    source: text().notNull().default('heuristic'),
    createdAt: createdAt(),
  },
  (t) => [
    index('highlights_project_start_idx').on(t.projectId, t.startSec),
    check('highlights_score', sql`${t.hookScore} between 0 and 100`),
    check('highlights_range', sql`${t.endSec} > ${t.startSec}`),
  ],
)

export const chapters = pgTable(
  'chapters',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    idx: integer().notNull(),
    title: text().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    /** 'llm' (a real model titled it), 'offline' (the built-in model), or 'heuristic' (the first words). */
    source: text().notNull().default('heuristic'),
    createdAt: createdAt(),
  },
  (t) => [
    index('chapters_project_start_idx').on(t.projectId, t.startSec),
    check('chapters_range', sql`${t.endSec} > ${t.startSec}`),
  ],
)

/** Quiet stretches found by FFmpeg, for "remove long pauses". */
export const silences = pgTable(
  'silences',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
  },
  (t) => [
    index('silences_project_start_idx').on(t.projectId, t.startSec),
    check('silences_range', sql`${t.endSec} > ${t.startSec}`),
  ],
)
