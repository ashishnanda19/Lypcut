import { eq } from 'drizzle-orm'
import {
  projects,
  transcriptSentences,
  transcripts,
  transcriptWords,
  userPreferences,
} from '../../db/schema/index.js'
import { buildTranscript } from '../../transcription/normalize.js'
import { TranscriptionError } from '../../transcription/types.js'
import { insertInChunks, languageLabel, type Stage } from '../context.js'
import { PermanentError } from '../errors.js'
import { contentHashOf } from '../../highlights/input.js'
import { downloadTo } from '../workdir.js'

const TRANSCRIBE_FAILED = "We couldn't transcribe this audio."

/**
 * Stage 5: speech to words. The engine sits behind an interface (local Whisper, OpenAI or AssemblyAI), so
 * this stage neither knows nor cares which. What comes back is turned into the editor's transcript: both
 * scripts for every word, each word marked Hindi or English, fillers flagged, sentences found. What was
 * spoken is stored as heard; the second spelling is added beside it, never in its place.
 */
export const transcribe: Stage = {
  key: 'transcribe',
  step: 2,
  from: 55,
  to: 80,
  async run(ctx) {
    const { db } = ctx.deps.database

    const [prefs] = await db
      .select({ language: userPreferences.language })
      .from(userPreferences)
      .where(eq(userPreferences.userId, ctx.project.ownerId))
    const hint = prefs?.language ?? 'hinglish'

    // The audio is in storage from the previous stage; fetch it if this attempt is on a fresh disk.
    if (!ctx.work.exists('audio.wav')) {
      await downloadTo(
        ctx.deps.storage,
        String(ctx.prior.audio?.audioKey),
        ctx.work.file('audio.wav'),
        ctx.signal,
      )
    }

    let raw
    try {
      raw = await ctx.provider.transcribe(ctx.work.file('audio.wav'), {
        language: hint,
        signal: ctx.signal,
        onProgress: ctx.progress,
      })
    } catch (e) {
      // A provider that refuses (bad key, unreadable audio) will refuse again: say so once, plainly, and
      // keep the technical reason in the log rather than showing a customer an API error.
      if (e instanceof TranscriptionError && !e.retryable) {
        ctx.log.error({ err: e, provider: ctx.provider.name }, 'transcription was refused')
        throw new PermanentError(TRANSCRIBE_FAILED, 'TRANSCRIPTION_FAILED')
      }
      throw e
    }

    const built = buildTranscript(raw, { hint })

    await db.transaction(async (tx) => {
      // Replace, never add to, an earlier attempt's transcript (the words and sentences go with it).
      await tx.delete(transcripts).where(eq(transcripts.projectId, ctx.project.id))
      const [row] = await tx
        .insert(transcripts)
        .values({
          projectId: ctx.project.id,
          language: built.language,
          provider: ctx.provider.name,
          model: ctx.provider.model,
          speakers: built.speakers,
          wordCount: built.words.length,
          contentHash: contentHashOf(built.words),
        })
        .returning({ id: transcripts.id })
      const transcriptId = row!.id

      await insertInChunks(
        built.words.map((w, idx) => ({
          transcriptId,
          projectId: ctx.project.id,
          idx,
          ...toColumns(w),
        })),
        (batch) => tx.insert(transcriptWords).values(batch),
        2000,
      )
      await insertInChunks(
        built.sentences.map((s) => ({
          transcriptId,
          projectId: ctx.project.id,
          idx: s.idx,
          speaker: s.speaker,
          fromWord: s.from,
          toWord: s.to,
          startSec: s.start,
          endSec: s.end,
          text: s.text,
          dev: s.dev,
          norm: s.norm,
        })),
        (batch) => tx.insert(transcriptSentences).values(batch),
      )
      await tx
        .update(projects)
        .set({ sourceLanguage: built.language })
        .where(eq(projects.id, ctx.project.id))
    })

    await ctx.report.update({
      found: { language: languageLabel(built.language), speakers: built.speakers.length },
    })
    return {
      words: built.words.length,
      sentences: built.sentences.length,
      language: built.language,
      provider: ctx.provider.name,
    }
  },
}

function toColumns(w: ReturnType<typeof buildTranscript>['words'][number]) {
  return {
    text: w.text,
    dev: w.dev,
    norm: w.norm,
    startSec: w.start,
    endSec: w.end,
    speaker: w.speaker,
    confidence: w.confidence,
    language: w.language,
    filler: w.filler,
  }
}
