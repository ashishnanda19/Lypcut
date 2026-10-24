import { eq } from 'drizzle-orm'
import { highlights, projects, transcripts } from '../../db/schema/index.js'
import { buildCandidates } from '../../highlights/candidates.js'
import { insightsKey, loadInsightInput } from '../../highlights/input.js'
import { scoreCandidates } from '../../highlights/scoring.js'
import { selectHighlights } from '../../highlights/select.js'
import { languageLabel, type Stage } from '../context.js'
import { PermanentError } from '../errors.js'

/**
 * Stage: find the moments most likely to hook a viewer. Code builds the candidate windows (every one starts on the
 * first word of a sentence and ends on the last word of one, 15 to 60 seconds) and ranks them by cheap signals; the model
 * scores and titles the best in one batched call; the top few that do not overlap are kept. The result is keyed by a
 * hash of the transcript, so running the stage again changes nothing, and it costs nothing.
 */
export const hooks: Stage = {
  key: 'hooks',
  step: 3,
  from: 80,
  to: 88,
  async run(ctx) {
    const { db } = ctx.deps.database
    const { config, llm } = ctx.deps
    const input = await loadInsightInput(db, ctx.project.id)
    if (!input) throw new PermanentError('The transcript is missing.', 'TRANSCRIPT_MISSING')
    const duration = Number(ctx.prior.probe?.durationSec)
    const key = insightsKey(input.contentHash, duration)

    if (input.highlightsHash === key) {
      const [row] = await db
        .select({ n: projects.hooksFound })
        .from(projects)
        .where(eq(projects.id, ctx.project.id))
      await ctx.report.update({ found: { hooks: row?.n ?? 0 } })
      return { cached: true, highlights: row?.n ?? 0 }
    }

    const candidates = buildCandidates({
      sentences: input.sentences,
      words: input.words,
      sceneCuts: input.sceneCuts,
      duration,
    })
    ctx.progress(0.2)

    const { scores, source } = await scoreCandidates(
      llm,
      candidates,
      { durationSec: duration, language: languageLabel(input.language) },
      { userId: ctx.project.ownerId, projectId: ctx.project.id },
      ctx.log,
      config.LLM_MAX_OUTPUT_TOKENS_BATCH,
      config.LLM_EFFORT_BATCH,
    )
    ctx.progress(0.8)

    const byId = new Map(scores.map((s) => [s.id, s]))
    const picked = selectHighlights(
      candidates.map((c) => {
        const s = byId.get(c.id)!
        return {
          start: c.start,
          end: c.end,
          title: s.title,
          hookScore: s.hookScore,
          reason: s.reason,
        }
      }),
      duration,
    )

    await db.transaction(async (tx) => {
      await tx.delete(highlights).where(eq(highlights.projectId, ctx.project.id))
      if (picked.length) {
        await tx.insert(highlights).values(
          picked.map((h, i) => ({
            projectId: ctx.project.id,
            idx: i,
            title: h.title,
            startSec: h.start,
            endSec: h.end,
            hookScore: h.hookScore,
            reason: h.reason,
            thumbSeed: `${ctx.project.id}-hook-${i}`,
            source,
          })),
        )
      }
      await tx
        .update(projects)
        .set({ hooksFound: picked.length })
        .where(eq(projects.id, ctx.project.id))
      // Only a model's answer is worth remembering. The cheap fallback is tried again next time.
      await tx
        .update(transcripts)
        .set({ highlightsHash: source === 'heuristic' ? null : key })
        .where(eq(transcripts.id, input.transcriptId))
    })

    await ctx.report.update({ found: { hooks: picked.length } })
    return { highlights: picked.length, candidates: candidates.length, source }
  },
}
