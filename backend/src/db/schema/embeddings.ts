import { doublePrecision, index, integer, pgTable, text, uuid, vector } from 'drizzle-orm/pg-core'
import { createdAt, pk } from './_helpers.js'
import { projects } from './projects.js'
import { transcripts } from './transcripts.js'

/** The size of every stored vector. Embedding providers must produce this many numbers. */
export const EMBEDDING_DIMENSIONS = 384

/**
 * One vector per sentence window, for search by meaning. Window `i` is sentences `i` to `i + 2` (fewer at the end), so
 * there is exactly one per sentence, and a window's position is the position of its first sentence. Deleting the
 * transcript or the project deletes these.
 */
export const sentenceEmbeddings = pgTable(
  'sentence_embeddings',
  {
    id: pk(),
    transcriptId: uuid()
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** First and last sentence in the window (inclusive), as sentence indices. */
    firstSentence: integer().notNull(),
    lastSentence: integer().notNull(),
    startSec: doublePrecision().notNull(),
    endSec: doublePrecision().notNull(),
    /** Unit length, so cosine distance and inner product agree. */
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    /** Which model made it: vectors from different models are not comparable. */
    model: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // A project's windows are few (hundreds, a few thousand for a long video), so the search reads them all by this index
    // and sorts by distance: exact, and fast enough that an approximate vector index would only add ways to be wrong.
    index('sentence_embeddings_project_idx').on(t.projectId, t.firstSentence),
    index('sentence_embeddings_transcript_idx').on(t.transcriptId),
  ],
)
