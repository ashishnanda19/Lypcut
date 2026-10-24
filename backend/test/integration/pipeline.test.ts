import fs from 'node:fs'
import path from 'node:path'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assets,
  chapters,
  highlights,
  jobs,
  jobStages,
  projects,
  scenes,
  silences,
  timelines,
  timelineVersions,
  transcriptSentences,
  transcripts,
  transcriptWords,
} from '../../src/db/schema/index.js'
import { probeMedia } from '../../src/lib/ffprobe.js'
import { CancelledError } from '../../src/media/ffmpeg.js'
import { NO_AUDIO_MESSAGE } from '../../src/pipeline/stages/audio.js'
import { requeueProcessingJob } from '../../src/pipeline/retry.js'
import { keyframeTimes } from '../../src/media/transform.js'
import { TranscriptionError } from '../../src/transcription/types.js'
import type { Timeline } from '@lypcut/timeline-core'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeSceneVideo } from '../helpers/media.js'
import { jobRow, startProcessing, tmpRoot, waitForJob, watchJob } from '../helpers/pipeline.js'
import { delay, ScriptedProvider, speaks } from '../helpers/provider.js'
import { fullUpload } from '../helpers/upload.js'
import { waitFor } from '../helpers/worker.js'
import { signup } from '../helpers/world.js'

let t: TestApp
let tmp: string
let sample: string

beforeAll(async () => {
  tmp = tmpRoot()
  // Three scenes (red 0-4, blue 4-9, green 9-15), a tone with a 2 second pause, a keyframe every second.
  sample = await makeSceneVideo({
    segments: [
      { color: 'red', seconds: 4 },
      { color: 'blue', seconds: 5 },
      { color: 'green', seconds: 6 },
    ],
    audio: [
      ['tone', 4.5],
      ['silence', 2],
      ['tone', 8.5],
    ],
  })
  // Quick retries, so failure paths do not make the suite slow.
  t = await createTestApp({ JOB_ATTEMPTS: '3', JOB_BACKOFF_MS: '50', TMP_DIR: tmp })
})
afterAll(async () => {
  await t.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

const db = () => t.deps.database.db
const tmpJobs = () => {
  const dir = path.join(tmp, 'lypcut')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

/** Uploads a file as a new user and returns what is needed to follow its processing. */
async function upload(file = sample, plan?: 'free' | 'creator') {
  const person = await signup(t, plan)
  const { projectId, done } = await fullUpload(person.c, file)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return { ...person, projectId, jobId: done.body.job.id as string }
}

describe('a successful run', () => {
  it('turns an upload into a ready project, reporting every step as it goes', async () => {
    const { c, id, projectId, jobId } = await upload()
    const provider = new ScriptedProvider(() => speaks())
    const watcher = await watchJob(t.deps, jobId)
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }
    await watcher.stop()

    // What a live viewer saw: the five steps in order, progress only ever going up, ending at Ready.
    const steps = [...new Set(watcher.seen.map((s) => s.step))]
    expect(steps).toEqual([0, 1, 2, 3, 4].filter((s) => steps.includes(s)))
    expect(steps).toEqual(expect.arrayContaining([1, 2, 3, 4]))
    const progress = watcher.seen.map((s) => s.progress)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    const labels = new Set(watcher.seen.map((s) => s.detail))
    for (const label of [
      'Splitting into clips',
      'Transcribing',
      'Indexing scenes and speakers',
      'Ready to edit',
    ]) {
      expect(labels, label).toContain(label)
    }
    const last = watcher.seen[watcher.seen.length - 1]!
    expect(last).toMatchObject({ status: 'done', progress: 100, step: 4 })

    // The job's findings, as the Processing screen shows them.
    const job = await jobRow(t.deps, jobId)
    expect(job.found).toMatchObject({
      scenes: 3,
      speakers: 1,
      language: 'Hinglish (Hindi + English)',
    })
    expect(job.found.hooks).toBeGreaterThanOrEqual(0)

    // The project.
    const project = (await c.get(`/api/projects/${projectId}`)).body
    expect(project.status).toBe('ready')
    expect(project.assets.map((a: { kind: string }) => a.kind).sort()).toEqual(['proxy', 'raw'])
    expect(project.assets.find((a: { kind: string }) => a.kind === 'proxy').url).toMatch(/^http/)
    expect(project.hooksFound).toBeGreaterThanOrEqual(0)
    expect(id).toBeTruthy()
  })

  it('stores scenes with thumbnails, clips cut from them, a proxy and the audio', async () => {
    const { projectId, jobId } = await upload()
    const worker = startProcessing(t.deps, new ScriptedProvider(() => speaks()))
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }

    const sceneRows = await db()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.idx))
    expect(sceneRows).toHaveLength(3)
    expect(sceneRows[0]!.startSec).toBe(0)
    expect(sceneRows[0]!.endSec).toBeCloseTo(4, 0)
    expect(sceneRows[1]!.endSec).toBeCloseTo(9, 0)
    expect(sceneRows[2]!.endSec).toBeGreaterThan(14)
    for (let i = 1; i < sceneRows.length; i++)
      expect(sceneRows[i]!.startSec).toBe(sceneRows[i - 1]!.endSec)

    const all = await db().select().from(assets).where(eq(assets.projectId, projectId))
    const ofKind = (k: string) => all.filter((a) => a.kind === k)
    expect(ofKind('thumbnail')).toHaveLength(3)
    expect(ofKind('scene_clip')).toHaveLength(3)
    expect(ofKind('proxy')).toHaveLength(1)
    expect(ofKind('audio')).toHaveLength(1)
    expect(all.every((a) => a.status === 'ready')).toBe(true)
    for (const a of all)
      expect(await t.deps.storage.head(a.storageKey), a.storageKey).not.toBeNull()
    // Every scene points at its thumbnail, and every clip at its scene.
    for (const s of sceneRows)
      expect(ofKind('thumbnail').some((a) => a.id === s.thumbnailAssetId)).toBe(true)
    for (const clip of ofKind('scene_clip'))
      expect(sceneRows.some((s) => s.id === clip.sceneId)).toBe(true)

    // The proxy plays: H.264, small, with a keyframe at least every second or so.
    const proxy = ofKind('proxy')[0]!
    const file = path.join(tmp, 'proxy-check.mp4')
    fs.writeFileSync(file, await t.deps.storage.getBuffer(proxy.storageKey))
    const info = await probeMedia(file)
    expect(info).toMatchObject({ videoCodec: 'h264', hasAudio: true })
    expect(info.height).toBeLessThanOrEqual(540)
    expect(info.durationSec).toBeGreaterThan(14)
    const keys = await keyframeTimes(file)
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeLessThan(1.3)

    // The audio is 16 kHz mono WAV; a thumbnail is a JPEG.
    const wav = await t.deps.storage.getBuffer(ofKind('audio')[0]!.storageKey)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    const jpg = await t.deps.storage.getBuffer(ofKind('thumbnail')[0]!.storageKey)
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8])
    fs.rmSync(file)
  })

  it('copies a clip when its cut is on a keyframe, and only re-encodes when it is not', async () => {
    // Keyframes every 5 s but a picture cut at 4 s: that scene cannot be copied cleanly.
    const awkward = await makeSceneVideo({
      segments: [
        { color: 'red', seconds: 4 },
        { color: 'blue', seconds: 6 },
      ],
      keyframeEverySec: 5,
    })
    const { projectId, jobId } = await upload(awkward)
    const worker = startProcessing(t.deps, new ScriptedProvider(() => speaks()))
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }
    const clips = await db()
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.kind, 'scene_clip')))
    const modes = clips.map((c) => (c.metadata as { cut: string }).cut)
    expect(modes).toContain('copy') // the first scene starts at 0, a keyframe
    expect(modes).toContain('reencode') // the second starts at 4 s, between keyframes
    const stage = (
      await db()
        .select()
        .from(jobStages)
        .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, 'split_proxy')))
    )[0]!
    expect(stage.output).toMatchObject({ copied: 1, reencoded: 1 })
  })

  it('stores the transcript with both scripts, languages, fillers, sentences and a search index', async () => {
    const { projectId, jobId } = await upload()
    const provider = new ScriptedProvider(() => speaks())
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }

    const [tr] = await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
    expect(tr).toMatchObject({ language: 'hinglish', provider: 'scripted', model: 'test-model' })
    expect(tr!.speakers).toEqual([{ id: 'S1', name: 'Speaker 1', color: 'saffron' }])

    const words = await db()
      .select()
      .from(transcriptWords)
      .where(eq(transcriptWords.projectId, projectId))
      .orderBy(asc(transcriptWords.idx))
    expect(words).toHaveLength(25)
    expect(words.map((w) => w.idx)).toEqual(words.map((_, i) => i))
    expect(words.slice(0, 7).map((w) => w.text)).toEqual([
      'namaste',
      'doston,',
      'aaj',
      'funding',
      'kaise',
      'raise',
      'karein?',
    ])
    expect(words[3]).toMatchObject({ dev: 'फंडिंग', language: 'en', speaker: 'S1' })
    expect(words[0]).toMatchObject({ dev: 'नमस्ते', language: 'hi' })
    expect(words.filter((w) => w.filler).map((w) => w.text)).toEqual(['um', 'matlab'])
    expect(words.every((w) => w.endSec > w.startSec)).toBe(true)

    const sentences = await db()
      .select()
      .from(transcriptSentences)
      .where(eq(transcriptSentences.projectId, projectId))
      .orderBy(asc(transcriptSentences.idx))
    expect(sentences.length).toBeGreaterThanOrEqual(3)
    expect(sentences[0]).toMatchObject({
      fromWord: 0,
      text: expect.stringMatching(/^namaste doston, aaj funding kaise raise karein\?/),
    })
    expect(sentences[sentences.length - 1]!.toWord).toBe(25)

    // The generated search column is filled in both scripts, so either finds the sentence.
    const roman = await db().execute(
      sql`select 1 from transcript_sentences where project_id = ${projectId} and search @@ plainto_tsquery('simple', 'funding')`,
    )
    const dev = await db().execute(
      sql`select 1 from transcript_sentences where project_id = ${projectId} and search @@ plainto_tsquery('simple', 'फंडिंग')`,
    )
    expect(roman.rowCount).toBe(1)
    expect(dev.rowCount).toBe(1)

    expect(
      (await db().select().from(projects).where(eq(projects.id, projectId)))[0]!.sourceLanguage,
    ).toBe('hinglish')
  })

  it('tells the provider the language the person said they speak', async () => {
    const { projectId, jobId, c } = await upload()
    await c.patch('/api/me', { language: 'en' })
    const provider = new ScriptedProvider(() => speaks())
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }
    expect(provider.languages).toEqual(['en'])
    expect(projectId).toBeTruthy()
  })

  it('finds silences, hooks and chapters, names scenes after chapters, and builds the first timeline', async () => {
    const { projectId, jobId } = await upload()
    const worker = startProcessing(t.deps, new ScriptedProvider(() => speaks()))
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }

    const quiet = await db().select().from(silences).where(eq(silences.projectId, projectId))
    expect(quiet.length).toBeGreaterThanOrEqual(1)
    expect(quiet.some((q) => q.startSec > 4 && q.startSec < 5.5)).toBe(true)

    // A 15 second recording cannot hold a highlight (they run 15 to 60 seconds), so there are none; the longer
    // recording in insights.test.ts covers finding them.
    const hooks = await db().select().from(highlights).where(eq(highlights.projectId, projectId))
    expect(hooks).toEqual([])
    const parts = await db()
      .select()
      .from(chapters)
      .where(eq(chapters.projectId, projectId))
      .orderBy(asc(chapters.idx))
    expect(parts[0]).toMatchObject({ title: 'Intro', startSec: 0 })

    const sceneRows = await db()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.idx))
    expect(sceneRows.every((s) => s.label.length > 0)).toBe(true)
    expect(sceneRows[0]!.label).toBe('Intro')

    // The timeline: version 0, two tracks of clips (video and voice), captions empty.
    const [tl] = await db().select().from(timelines).where(eq(timelines.projectId, projectId))
    expect(tl).toMatchObject({ currentVersion: 0, lastVersion: 0 })
    const [v0] = await db()
      .select()
      .from(timelineVersions)
      .where(eq(timelineVersions.timelineId, tl!.id))
    expect(v0).toMatchObject({ n: 0, label: 'Original upload', createdBy: 'user' })
    const timeline = v0!.snapshot as unknown as Timeline
    expect(timeline.tracks.map((x) => x.kind)).toEqual([
      'video',
      'broll',
      'audio',
      'captions',
      'broll',
      'effects',
    ])
    const items = Object.values(timeline.items)
    expect(items.filter((i) => i.kind === 'video')).toHaveLength(3)
    expect(items.filter((i) => i.kind === 'audio')).toHaveLength(3)
    expect(items.filter((i) => i.kind === 'caption' || i.kind === 'broll')).toHaveLength(0)
    expect(timeline.sourceDuration).toBeGreaterThan(14)
    expect(timeline.settings).toMatchObject({ captionsOn: false, aspect: '9:16' })
    // Clips are labelled from the scenes and tile the source with no gaps.
    const video = items.filter((i) => i.kind === 'video').sort((a, b) => a.start - b.start)
    expect(video.map((v) => v.label)).toEqual(sceneRows.map((s) => s.label))
    expect(video[0]!.start).toBe(0)
    for (const v of video) expect(v.srcIn).toBe(v.start)
  })

  it('cleans up its temporary files', async () => {
    const { jobId } = await upload()
    const worker = startProcessing(t.deps, new ScriptedProvider(() => speaks()))
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }
    await delay(100)
    expect(tmpJobs()).toEqual([])
  })
})

describe('when things go wrong', () => {
  it('retries a transient failure and carries on from the stage that failed, not from the start', async () => {
    const { jobId } = await upload()
    const provider = new ScriptedProvider((call) => {
      if (call === 1) throw new TranscriptionError('the service hiccupped', true)
      return speaks()
    })
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'done')
    } finally {
      await worker.close()
    }
    expect(provider.calls).toBe(2)

    const stages = await db().select().from(jobStages).where(eq(jobStages.jobId, jobId))
    const attempts = Object.fromEntries(stages.map((s) => [s.stage, s.attempts]))
    // Everything before transcription ran once; transcription twice; the rest once.
    expect(attempts).toEqual({
      probe: 1,
      scenes: 1,
      split_proxy: 1,
      audio: 1,
      transcribe: 2,
      hooks: 1,
      chapters: 1,
      index: 1,
      timeline: 1,
      ready: 1,
    })
    expect(stages.every((s) => s.status === 'done')).toBe(true)
    expect(tmpJobs()).toEqual([])
  })

  it('does not retry what cannot work, and shows the same failure the mock does', async () => {
    const { c, projectId, jobId } = await upload()
    const provider = new ScriptedProvider(() => {
      throw new TranscriptionError('401 invalid api key sk-secret-123', false)
    })
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'failed')
    } finally {
      await worker.close()
    }
    expect(provider.calls).toBe(1)

    const job = await jobRow(t.deps, jobId)
    expect(job).toMatchObject({
      status: 'failed',
      step: 2,
      detail: 'Transcribing stopped',
      error: "We couldn't transcribe this audio.",
      errorCode: 'TRANSCRIPTION_FAILED',
    })
    // A technical reason (and certainly an API key) never reaches what the customer sees.
    expect(JSON.stringify(job)).not.toContain('sk-secret')
    const project = (await c.get(`/api/projects/${projectId}`)).body
    expect(project.status).toBe('failed')
    expect(tmpJobs()).toEqual([])
  })

  it('a file with no audio track fails at the same point, with the same words, as the mock', async () => {
    const silent = await makeSceneVideo({ segments: [{ color: 'red', seconds: 5 }], audio: 'none' })
    const { jobId } = await upload(silent)
    const provider = new ScriptedProvider(() => speaks())
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'failed')
    } finally {
      await worker.close()
    }
    expect(provider.calls).toBe(0)
    const job = await jobRow(t.deps, jobId)
    expect(job).toMatchObject({
      status: 'failed',
      step: 2,
      detail: 'Transcribing stopped',
      error: NO_AUDIO_MESSAGE,
      errorCode: 'NO_AUDIO',
    })
    // The earlier stages still did their work and keep it.
    expect(job.found).toMatchObject({ scenes: expect.any(Number) })
  })

  it('after the retries run out, marks the job failed and keeps it as a dead letter', async () => {
    const { projectId, jobId } = await upload()
    const provider = new ScriptedProvider(() => {
      throw new TranscriptionError('still down', true)
    })
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'failed')
    } finally {
      await worker.close()
    }
    expect(provider.calls).toBe(3) // JOB_ATTEMPTS
    const job = await jobRow(t.deps, jobId)
    expect(job.attempts).toBe(3)
    expect(job.error).toBe('Something went wrong while processing this video. Please try again.')
    expect((await db().select().from(projects).where(eq(projects.id, projectId)))[0]!.status).toBe(
      'failed',
    )
    // The queue keeps the failed job for inspection.
    const failed = await t.deps.queues.processing.getFailed()
    expect(failed.map((j) => j.id)).toContain(jobId)
    // And the technical reason is kept on the stage, for whoever investigates.
    const stage = (
      await db()
        .select()
        .from(jobStages)
        .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, 'transcribe')))
    )[0]!
    expect(stage).toMatchObject({ status: 'failed', attempts: 3 })
    expect(stage.error).toMatch(/still down/)
  })

  it('a failed job, retried by the user, resumes at the stage that failed', async () => {
    const { c, projectId, jobId } = await upload()
    let healthy = false
    const provider = new ScriptedProvider(() => {
      if (!healthy) throw new TranscriptionError('refused', false)
      return speaks()
    })
    const worker = startProcessing(t.deps, provider)
    try {
      await waitForJob(t.deps, jobId, 'failed')
      const before = await db().select().from(jobStages).where(eq(jobStages.jobId, jobId))
      const startedBefore = Object.fromEntries(before.map((s) => [s.stage, s.startedAt?.getTime()]))

      healthy = true
      await requeueProcessingJob(t.deps, jobId)
      // It is queued again at once, under the same id, with the project back to processing.
      expect((await c.get(`/api/projects/${projectId}`)).body.status).toBe('processing')
      await waitForJob(t.deps, jobId, 'done')

      const after = await db().select().from(jobStages).where(eq(jobStages.jobId, jobId))
      const byStage = Object.fromEntries(after.map((s) => [s.stage, s]))
      for (const s of ['probe', 'scenes', 'split_proxy', 'audio']) {
        expect(byStage[s]!.attempts, s).toBe(1)
        expect(byStage[s]!.startedAt?.getTime(), `${s} was not started again`).toBe(
          startedBefore[s],
        )
      }
      expect(byStage.transcribe!.attempts).toBe(2)
      expect((await jobRow(t.deps, jobId)).error).toBeNull()
      expect((await c.get(`/api/projects/${projectId}`)).body.status).toBe('ready')
    } finally {
      await worker.close()
    }
  })

  it('running a stage again replaces its output instead of duplicating it', async () => {
    const { projectId, jobId } = await upload()
    const worker = startProcessing(t.deps, new ScriptedProvider(() => speaks()))
    const counts = async () => ({
      scenes: (await db().select().from(scenes).where(eq(scenes.projectId, projectId))).length,
      assets: (await db().select().from(assets).where(eq(assets.projectId, projectId))).length,
      words: (
        await db().select().from(transcriptWords).where(eq(transcriptWords.projectId, projectId))
      ).length,
      sentences: (
        await db()
          .select()
          .from(transcriptSentences)
          .where(eq(transcriptSentences.projectId, projectId))
      ).length,
      hooks: (await db().select().from(highlights).where(eq(highlights.projectId, projectId)))
        .length,
      chapters: (await db().select().from(chapters).where(eq(chapters.projectId, projectId)))
        .length,
      silences: (await db().select().from(silences).where(eq(silences.projectId, projectId)))
        .length,
      timelines: (await db().select().from(timelines).where(eq(timelines.projectId, projectId)))
        .length,
      transcripts: (
        await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
      ).length,
    })
    try {
      await waitForJob(t.deps, jobId, 'done')
      const first = await counts()
      // Wipe the checkpoints so every stage runs a second time.
      await db().update(jobStages).set({ status: 'pending' }).where(eq(jobStages.jobId, jobId))
      await requeueProcessingJob(t.deps, jobId)
      await waitFor(
        async () =>
          (await db().select().from(jobStages).where(eq(jobStages.jobId, jobId))).every(
            (s) => s.attempts === 2 && s.status === 'done',
          ),
        90_000,
        'a second full run',
      )
      expect(await counts()).toEqual(first)
      expect(first.timelines).toBe(1)
    } finally {
      await worker.close()
    }
  })
})

describe('when the project is deleted mid-way', () => {
  it('stops the work, leaves nothing behind and does not bring the project back', async () => {
    const { c, projectId, jobId } = await upload()
    let started!: () => void
    const began = new Promise<void>((resolve) => (started = resolve))
    let sawAbort = false
    const provider = new ScriptedProvider(
      (_call, opts) =>
        new Promise((_resolve, reject) => {
          started()
          opts.signal?.addEventListener('abort', () => {
            sawAbort = true
            reject(new CancelledError())
          })
        }),
    )
    const worker = startProcessing(t.deps, provider)
    try {
      await began // transcription is under way, so every earlier stage has finished
      expect((await c.del(`/api/projects/${projectId}`)).status).toBe(200)
      // The worker notices within a few seconds and stops.
      await waitFor(async () => sawAbort, 15_000, 'the worker to be told to stop')
      await waitFor(async () => tmpJobs().length === 0, 10_000, 'temporary files to be removed')
    } finally {
      await worker.close()
    }
    expect(await db().select().from(projects).where(eq(projects.id, projectId))).toHaveLength(0)
    expect(await db().select().from(transcripts)).toHaveLength(0)
    expect(await db().select().from(transcriptWords)).toHaveLength(0)
    expect(await db().select().from(timelines)).toHaveLength(0)
    expect(await db().select().from(jobs).where(eq(jobs.id, jobId))).toHaveLength(0)
  })

  it('a job whose project is already gone is simply skipped', async () => {
    const { c, projectId, jobId } = await upload()
    await c.del(`/api/projects/${projectId}`)
    const provider = new ScriptedProvider(() => speaks())
    const worker = startProcessing(t.deps, provider)
    await delay(1500)
    await worker.close()
    expect(provider.calls).toBe(0)
    expect(await db().select().from(jobs).where(eq(jobs.id, jobId))).toHaveLength(0)
  })
})

describe('limits on running at once', () => {
  it('runs only as many jobs at once as PROCESSING_CONCURRENCY allows', async () => {
    const a = await upload()
    const b = await upload()
    const provider = new ScriptedProvider(async () => {
      await delay(300)
      return speaks()
    })
    const worker = startProcessing(t.deps, provider) // PROCESSING_CONCURRENCY defaults to 1
    try {
      await Promise.all([waitForJob(t.deps, a.jobId, 'done'), waitForJob(t.deps, b.jobId, 'done')])
    } finally {
      await worker.close()
    }
    expect(provider.calls).toBe(2)
    expect(provider.maxActive).toBe(1)
  })

  it('runs two at once when allowed to', async () => {
    const wide = await createTestApp({
      PROCESSING_CONCURRENCY: '2',
      JOB_ATTEMPTS: '1',
      TMP_DIR: tmp,
    })
    try {
      const people = [await signup(wide), await signup(wide)]
      const jobIds: string[] = []
      for (const p of people) jobIds.push((await fullUpload(p.c, sample)).done.body.job.id)
      const provider = new ScriptedProvider(async () => {
        await delay(1500)
        return speaks()
      })
      const worker = startProcessing(wide.deps, provider)
      try {
        await Promise.all(jobIds.map((id) => waitForJob(wide.deps, id, 'done')))
      } finally {
        await worker.close()
      }
      expect(provider.maxActive).toBe(2)
    } finally {
      await wide.close()
    }
  })
})
