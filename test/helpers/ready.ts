import {
  assets,
  chapters,
  highlights,
  projects,
  scenes,
  silences,
  timelines,
  timelineVersions,
  transcriptSentences,
  transcripts,
  transcriptWords,
} from '../../src/db/schema/index.js'
import { findChapters, findHighlights } from '../../src/transcription/insights.js'
import { fixtureTranscript, LINES } from './transcript-fixture.js'
import type { Timeline } from '../../src/timeline-core/types.js'
import type { TestApp } from './app.js'
import { sampleTimeline } from './timeline.js'
import type { Person } from './world.js'

export interface ReadyProject {
  /** The transcript that was stored, when `content` was asked for. */
  content?: ReturnType<typeof fixtureTranscript>
  projectId: string
  /** The timeline as the pipeline would have built it (version 0). */
  timeline: Timeline
  words: Array<{ start: number; end: number }>
}

/**
 * A finished project with a timeline at version 0, made directly in the database. The timeline is the same layout
 * the pipeline builds. Skipping the pipeline keeps the tests of the edit API fast and focused.
 */
export async function readyProject(
  t: TestApp,
  person: Person,
  opts: { title?: string; fileName?: string; content?: boolean | typeof LINES } = {},
): Promise<ReadyProject> {
  const { db } = t.deps.database
  const sample = sampleTimeline()
  const [project] = await db
    .insert(projects)
    .values({
      ownerId: person.id,
      title: opts.title ?? 'Funding kaise raise karein',
      status: 'ready',
      durationSec: sample.duration,
      thumbSeed: 'seed',
    })
    .returning()
  await db.insert(assets).values({
    projectId: project!.id,
    kind: 'raw',
    status: 'ready',
    storageKey: `users/${person.id}/projects/${project!.id}/raw/x.mp4`,
    label: opts.fileName ?? 'Funding kaise raise karein.mp4',
    durationSec: sample.duration,
  })
  const [tl] = await db
    .insert(timelines)
    .values({ projectId: project!.id, sourceDuration: sample.duration })
    .returning()
  await db.insert(timelineVersions).values({
    timelineId: tl!.id,
    n: 0,
    parentN: null,
    createdBy: 'user',
    label: 'Original upload',
    snapshot: sample.timeline as unknown as Record<string, unknown>,
    op: { type: 'batch', ops: [] },
    inverse: { type: 'batch', ops: [] },
  })
  const content = opts.content
    ? await seedContent(t, project!.id, person.id, opts.content === true ? LINES : opts.content)
    : undefined
  return { projectId: project!.id, timeline: sample.timeline, words: sample.words, content }
}

/**
 * Stores a full set of content for a project: transcript, words, sentences, scenes with thumbnails, a proxy,
 * silences, hooks and chapters. The files are real objects in storage, so links can be followed.
 */
export async function seedContent(
  t: TestApp,
  projectId: string,
  userId: string,
  lines: typeof LINES = LINES,
) {
  const { db } = t.deps.database
  const fx = fixtureTranscript(lines)
  const tr = fx.transcript
  const prefix = `users/${userId}/projects/${projectId}`

  const [row] = await db
    .insert(transcripts)
    .values({
      projectId,
      language: tr.language,
      provider: 'fixture',
      model: 'none',
      speakers: tr.speakers,
      wordCount: tr.words.length,
    })
    .returning()
  const wordRows = tr.words.map((w, idx) => ({
    transcriptId: row!.id,
    projectId,
    idx,
    text: w.text,
    dev: w.dev,
    norm: w.norm,
    startSec: w.start,
    endSec: w.end,
    speaker: w.speaker,
    confidence: w.confidence,
    language: w.language,
    filler: w.filler,
  }))
  for (let i = 0; i < wordRows.length; i += 2000) {
    await db.insert(transcriptWords).values(wordRows.slice(i, i + 2000))
  }
  const sentenceRows = tr.sentences.map((s) => ({
    transcriptId: row!.id,
    projectId,
    idx: s.idx,
    speaker: s.speaker,
    fromWord: s.from,
    toWord: s.to,
    startSec: s.start,
    endSec: s.end,
    text: s.text,
    dev: s.dev,
    norm: s.norm,
  }))
  for (let i = 0; i < sentenceRows.length; i += 1000) {
    await db.insert(transcriptSentences).values(sentenceRows.slice(i, i + 1000))
  }

  // Three scenes, each with a real thumbnail object.
  const third = fx.duration / 3
  const thumbs: string[] = []
  for (let i = 0; i < 3; i++) {
    const key = `${prefix}/thumbs/scene-${i}.jpg`
    await t.deps.storage.putObject(key, Buffer.from(`thumb-${i}`), 'image/jpeg')
    const [a] = await db
      .insert(assets)
      .values({
        projectId,
        kind: 'thumbnail',
        status: 'ready',
        storageKey: key,
        label: `Thumbnail ${i + 1}`,
        mimeType: 'image/jpeg',
        sizeBytes: 8,
      })
      .returning()
    thumbs.push(a!.id)
  }
  await db.insert(scenes).values(
    thumbs.map((thumbnailAssetId, i) => ({
      projectId,
      idx: i,
      label: i === 0 ? 'Intro' : `Scene ${i + 1}`,
      startSec: i * third,
      endSec: (i + 1) * third,
      thumbnailAssetId,
    })),
  )
  const proxyKey = `${prefix}/proxy/proxy.mp4`
  await t.deps.storage.putObject(proxyKey, Buffer.from('proxy-bytes'), 'video/mp4')
  await db.insert(assets).values({
    projectId,
    kind: 'proxy',
    status: 'ready',
    storageKey: proxyKey,
    label: 'Editing proxy (540p)',
    mimeType: 'video/mp4',
    sizeBytes: 11,
    durationSec: fx.duration,
    width: 960,
    height: 540,
  })
  await db.insert(assets).values({
    projectId,
    kind: 'scene_clip',
    status: 'pending',
    storageKey: `${prefix}/scenes/pending.mp4`,
    label: 'Not ready',
  })

  await db.insert(silences).values([
    { projectId, startSec: 10, endSec: 11.2 },
    { projectId, startSec: 30, endSec: 31 },
  ])
  const hooks = findHighlights(tr.sentences, tr.words, fx.duration)
  if (hooks.length) {
    await db.insert(highlights).values(
      hooks.map((h, i) => ({
        projectId,
        idx: i,
        title: h.title,
        startSec: h.start,
        endSec: h.end,
        hookScore: h.hookScore,
        reason: h.reason,
        thumbSeed: `${projectId}-hook-${i}`,
      })),
    )
  }
  const parts = findChapters(tr.sentences, fx.duration, { minSec: 20 })
  if (parts.length) {
    await db.insert(chapters).values(
      parts.map((c, i) => ({
        projectId,
        idx: i,
        title: c.title,
        startSec: c.start,
        endSec: c.end,
      })),
    )
  }
  return fx
}
