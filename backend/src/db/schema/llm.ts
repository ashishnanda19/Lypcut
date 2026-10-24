import { boolean, doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { llmKindEnum } from './enums.js'
import { createdAt, pk } from './_helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

/**
 * One row per language-model call (or embedding batch): who, which project, what for, how many tokens, what it cost
 * and how it went. Summed for the monthly budget and the daily assistant limit. Holds no prompt or reply text.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: pk(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    kind: llmKindEnum().notNull(),
    /** Which implementation answered: anthropic, fake, local-embeddings ... */
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    /** Estimated, from the price table. */
    costUsd: doublePrecision().notNull().default(0),
    latencyMs: integer().notNull().default(0),
    /** ok, or the kind of failure (timeout, rate_limited, refused, malformed ...). */
    outcome: text().notNull(),
    /** The offline model answered because the real one was over budget or failing, not because it is configured. */
    degraded: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('llm_usage_user_kind_created_idx').on(t.userId, t.kind, t.createdAt),
    index('llm_usage_created_idx').on(t.createdAt),
  ],
)
