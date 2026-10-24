import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Log } from '../../lib/log.js'
import type { AppDeps } from '../../app/types.js'
import { transcriptSentences, transcripts, transcriptWords } from '../../db/schema/index.js'
import { requireReady } from '../content/service.js'
import { closeWindows, fuse, type LexicalHit } from './fusion.js'
import { nearestWindows, QueryVectorCache, type SemanticWindow } from './semantic.js'
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
  private readonly queryVectors: QueryVectorCache
  private lastWarn = 0

  constructor(
    private readonly deps: AppDeps,
    private readonly log?: Log,
  ) {
    this.queryVectors = new QueryVectorCache(deps.config.EMBEDDING_QUERY_CACHE_SEC * 1000)
  }

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

    const [tr] = await db
      .select({ id: transcripts.id })
      .from(transcripts)
      .where(eq(transcripts.projectId, projectId))
    if (!tr) return []

    // By words and by meaning at the same time. If meaning is unavailable (no vectors, no model, a failure) the second
    // list is empty and the answer is exactly what the words alone give.
    const [lexical, windows] = await Promise.all([
      this.lexicalHits(tr.id, terms),
      this.semanticWindows(projectId, query),
    ])

    if (!windows.length) {
      if (!lexical.length) return []
      return this.assemble(tr.id, lexical, limit)
    }

    const wanted = new Set<number>()
    for (const w of windows) {
      wanted.add(w.first)
      wanted.add(w.last)
    }
    const rows = await this.sentenceRows(tr.id, [...wanted])
    const fused = fuse(lexical, windows, this.deps.embeddings.similarityFloor, (idx) =>
      rows.get(idx),
    )
    // The fusion decides which moments make the cut; the rest of the work is the same as for words alone.
    return this.assemble(tr.id, fused.slice(0, limit * 3), limit)
  }

  /** Turns scored sentences into clips, widening a short sentence with the one after it. */
  private async assemble(
    transcriptId: string,
    hits: LexicalHit[],
    limit: number,
  ): Promise<SearchHit[]> {
    const next = await this.sentenceRows(transcriptId, [
      ...new Set(hits.map((h) => h.sentence.idx + 1)),
    ])
    return assembleResults(hits, (idx) => next.get(idx + 1), limit)
  }

  private async sentenceRows(
    transcriptId: string,
    idxs: number[],
  ): Promise<Map<number, SentenceRow>> {
    const { db } = this.deps.database
    const rows = await this.inChunks(idxs, (ids) =>
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
          and(
            eq(transcriptSentences.transcriptId, transcriptId),
            inArray(transcriptSentences.idx, ids),
          ),
        ),
    )
    return new Map(rows.map((r) => [r.idx, toRow(r)]))
  }

  /** Sentences that match the words of the query, scored. */
  private async lexicalHits(
    transcriptId: string,
    terms: ReturnType<typeof queryTerms>,
  ): Promise<LexicalHit[]> {
    const { db } = this.deps.database
    const candidates = await this.candidates(transcriptId, candidateForms(terms))
    if (!candidates.length) return []

    // Load just the words of the candidate sentences.
    const wanted = new Set<number>()
    for (const s of candidates) for (let i = s.from; i < s.to; i++) wanted.add(i)
    const wordRows = await this.inChunks([...wanted], (ids) =>
      db
        .select({ idx: transcriptWords.idx, norm: transcriptWords.norm, dev: transcriptWords.dev })
        .from(transcriptWords)
        .where(
          and(eq(transcriptWords.transcriptId, transcriptId), inArray(transcriptWords.idx, ids)),
        ),
    )
    const words = new Map<number, MatchWord>(
      wordRows.map((w) => [w.idx, { norm: w.norm, dev: w.dev }]),
    )
    const hits: LexicalHit[] = []
    for (const sentence of candidates) {
      const scored = scoreSentence(terms, sentence, (i) => words.get(i))
      if (scored) hits.push({ sentence, ...scored })
    }
    return hits
  }

  /** Windows of the video closest in meaning to the query. Empty, never an error, if meaning cannot be asked. */
  private async semanticWindows(projectId: string, query: string): Promise<SemanticWindow[]> {
    const provider = this.deps.embeddings
    try {
      const key = `${provider.model}|${query.trim().toLowerCase()}`
      let vector = this.queryVectors.get(key)
      if (!vector) {
        vector = (await provider.embed([query.trim()], 'query'))[0]
        if (!vector) return []
        this.queryVectors.set(key, vector)
      }
      const windows = await nearestWindows(
        this.deps.database.db,
        projectId,
        provider.model,
        vector,
        20,
      )
      return closeWindows(windows, provider.similarityFloor)
    } catch (e) {
      // Search by words still works, so this is a note in the log, not an error for the person searching.
      if (Date.now() - this.lastWarn > 60_000) {
        this.lastWarn = Date.now()
        this.log?.warn(
          { err: e instanceof Error ? e.message : 'unknown', provider: provider.name },
          'search by meaning unavailable; using words only',
        )
      }
      return []
    }
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
