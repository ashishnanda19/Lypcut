import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { langEnum, wordLangEnum } from './enums.js'
import { createdAt, pk, rawSql, tsvector } from './_helpers.js'
import { projects } from './projects.js'

export interface SpeakerRow {
  id: string
  name: string
  color: 'saffron' | 'teal'
}

/** One transcript per project. */
export const transcripts = pgTable(
  'transcripts',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    language: langEnum().notNull(),
    /** Which transcription provider and model produced it. */
    provider: text().notNull(),
    model: text(),
    speakers: jsonb().$type<SpeakerRow[]>().notNull().default([]),
    wordCount: integer().notNull().default(0),
    /** SHA-256 over the words and their times. What highlights, chapters and embeddings are keyed by. */
    contentHash: text(),
    /** The content hash (and algorithm version) the stored highlights were computed for. Null: not yet, or only roughly. */
    highlightsHash: text(),
    chaptersHash: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('transcripts_project_uq').on(t.projectId)],
)

/**
 * Words in SOURCE time. `text` is Roman (Hinglish) spelling, `dev` the Devanagari spelling, `norm` a
 * lower-cased, punctuation-free form used for search. All three are kept: what was said is never rewritten.
 */
export const transcriptWords = pgTable(
  'transcript_words',
  {
    id: pk(),
    transcriptId: uuid()
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    /** Denormalised so the (project, start) index can answer time-range reads without a join. */
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Position in the transcript. The front end addresses words by this index. */
    idx: integer().notNull(),
    text: text().notNull(),
    dev: text().notNull(),
    norm: text().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    speaker: text().notNull(),
    confidence: real(),
    language: wordLangEnum().notNull(),
    filler: boolean().notNull().default(false),
  },
  (t) => [
    index('words_project_start_idx').on(t.projectId, t.startSec),
    uniqueIndex('words_transcript_idx_uq').on(t.transcriptId, t.idx),
    // Fuzzy matching for Hinglish spellings ("funding" / "phunding"). Needs the pg_trgm extension.
    index('words_norm_trgm_idx').using('gin', t.norm.op('gin_trgm_ops')),
    check('words_range', sql`${t.startSec} >= 0 and ${t.endSec} >= ${t.startSec}`),
  ],
)

/** A run of words by one speaker. The unit the search panel ranks. */
export const transcriptSentences = pgTable(
  'transcript_sentences',
  {
    id: pk(),
    transcriptId: uuid()
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    idx: integer().notNull(),
    speaker: text().notNull(),
    /** Index of the first word (inclusive) and one past the last word (exclusive), as in the front end. */
    fromWord: integer().notNull(),
    toWord: integer().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    text: text().notNull(),
    dev: text().notNull(),
    norm: text().notNull(),
    /** Full-text vector over both scripts. 'simple' config: no English stemming, which Hindi would not survive. */
    search: tsvector().generatedAlwaysAs(
      rawSql(`to_tsvector('simple', coalesce("norm", '') || ' ' || coalesce("dev", ''))`),
    ),
  },
  (t) => [
    index('sentences_project_start_idx').on(t.projectId, t.startSec),
    uniqueIndex('sentences_transcript_idx_uq').on(t.transcriptId, t.idx),
    index('sentences_search_idx').using('gin', t.search),
    index('sentences_norm_trgm_idx').using('gin', t.norm.op('gin_trgm_ops')),
    check('sentences_words', sql`${t.toWord} > ${t.fromWord}`),
  ],
)
