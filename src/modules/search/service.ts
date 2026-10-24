import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AppDeps } from '../../app/types.js'
import { transcriptSentences, transcripts, transcriptWords } from '../../db/schema/index.js'
import { requireReady } from '../content/service.js'
import {
  assembleResults,
  candidateForms,
  queryTerms,
  scoreSentence,
  type MatchWord,
  type SearchHit,
  type SentenceRow,
} from './match.js'

/** Narrowing returns at most this many sentences; scoring and ranking happen on those. */
const MAX_CANDIDATES = 600
/** How alike a word must be (trigram word similarity) to count as a candidate. Scoring makes the real decision. */
const FUZZY_THRESHOLD = 0.45
const MIN_FUZZY_LENGTH = 4

/** Escapes LIKE's wildcards so a query is only ever matched as text. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

interface SentenceRecord extends Record<string, unknown> {
  idx: number
  from_word: number
  to_word: number
  start_sec: number
  end_sec: number
}

const toRow = (r: SentenceRecord): SentenceRow => ({
  idx: r.idx,
  from: r.from_word,
  to: r.to_word,
  start: r.start_sec,
  end: r.end_sec,
})

/**
 * Search over a project's transcript. The database does the cheap, indexed part: sentences that could possibly match
 * (full-text prefix match on the Roman form, trigram similarity for near spellings, a substring match for Devanagari).
 * Only those few hundred sentences have their words loaded and scored, in code, with the algorithm the editor has
 * always used. Scoring in code rather than SQL keeps the ranking independent of the database's locale, which affects
 * how Devanagari is split into words.
 */
export class SearchService {
  constructor(private readonly deps: AppDeps) {}

  async search(
    userId: string,
    projectId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const { db } = this.deps.database
    await requireReady(db, userId, projectId)

    const terms = queryTerms(query)
    if (!terms.length) return []
    const forms = candidateForms(terms)

    const [tr] = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.projectId, projectId))
    if (!tr) return []

    const candidates = await this.candidates(tr.id, forms)
    if (!candidates.length) return []

    // Load just the words of the candidate sentences (and the sentence after each, for context).
    const wanted = new Set<number>()
    for (const s of candidates) for (let i = s.from; i < s.to; i++) wanted.add(i)
    const wordRows = await this.inChunks([...wanted], (ids) =>
      db
        .select({ idx: transcriptWords.idx, norm: transcriptWords.norm, dev: transcriptWords.dev })
        .from(transcriptWords)
        .where(and(eq(transcriptWords.transcriptId, tr.id), inArray(transcriptWords.idx, ids))),
    )
    const words = new Map<number, MatchWord>(
      wordRows.map((w) => [w.idx, { norm: w.norm, dev: w.dev }]),
    )

    const hits: Array<{ sentence: SentenceRow; score: number; matched: number[] }> = []
    for (const sentence of candidates) {
      const scored = scoreSentence(terms, sentence, (i) => words.get(i))
      if (scored) hits.push({ sentence, ...scored })
    }
    if (!hits.length) return []

    const nextRows = await this.inChunks([...new Set(hits.map((h) => h.sentence.idx + 1))], (ids) =>
      db
        .select({
          idx: transcriptSentences.idx,
          from_word: transcriptSentences.fromWord,
          to_word: transcriptSentences.toWord,
          start_sec: transcriptSentences.startSec,
          end_sec: transcriptSentences.endSec,
        })
        .from(transcriptSentences)
        .where(
          and(eq(transcriptSentences.transcriptId, tr.id), inArray(transcriptSentences.idx, ids)),
        ),
    )
    const next = new Map(nextRows.map((r) => [r.idx, toRow(r)]))

    return assembleResults(hits, (idx) => next.get(idx + 1), limit)
  }

  /** Runs a lookup over a long list of ids in pieces, so one query never carries an enormous parameter list. */
  private async inChunks<T>(ids: number[], run: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += 5000) out.push(...(await run(ids.slice(i, i + 5000))))
    return out
  }

  private async candidates(
    transcriptId: string,
    forms: { roman: string[]; dev: string[] },
  ): Promise<SentenceRow[]> {
    const conditions = []
    if (forms.roman.length) {
      // Folded keys are plain a-z0-9, so this tsquery cannot be malformed by what a person typed.
      const prefix = forms.roman.map((k) => `${k}:*`).join(' | ')
      conditions.push(sql`search @@ to_tsquery('simple', ${prefix})`)
      for (const key of forms.roman.filter((k) => k.length >= MIN_FUZZY_LENGTH)) {
        // `<%` uses the trigram index and the threshold set below.
        conditions.push(sql`${key}::text <% norm`)
      }
    }
    for (const word of forms.dev) {
      conditions.push(sql`dev ilike ${`%${likeEscape(word)}%`}`)
    }
    if (!conditions.length) return []

    const where = sql.join(conditions, sql` or `)
    const rows = await this.deps.database.db.transaction(async (tx) => {
      // Local to this transaction: it does not change the setting for anyone else.
      await tx.execute(
        sql`select set_config('pg_trgm.word_similarity_threshold', ${String(FUZZY_THRESHOLD)}, true)`,
      )
      return tx.execute<SentenceRecord>(sql`
        select idx, from_word, to_word, start_sec, end_sec from transcript_sentences
        where transcript_id = ${transcriptId} and (${where})
        order by idx limit ${MAX_CANDIDATES}`)
    })
    return rows.rows.map(toRow)
  }
}
