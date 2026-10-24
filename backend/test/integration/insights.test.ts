import fs from 'node:fs'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  chapters,
  highlights,
  jobs,
  sentenceEmbeddings,
  jobStages,
  llmUsage,
  projects,
  scenes,
  transcriptSentences,
  transcripts,
} from '../../src/db/schema/index.js'
import { hooks } from '../../src/pipeline/stages/hooks.js'
import { chaptersStage } from '../../src/pipeline/stages/chapters.js'
import type { PipelineContext } from '../../src/pipeline/context.js'
import type { RawWord } from '../../src/transcription/types.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { resetDatabase } from '../helpers/db.js'
import { makeSceneVideo } from '../helpers/media.js'
import { startProcessing, tmpRoot, waitForJob } from '../helpers/pipeline.js'
import { ScriptedProvider } from '../helpers/provider.js'
import { TopicEmbeddings } from '../helpers/embeddings.js'
import { fullUpload } from '../helpers/upload.js'
import { signup } from '../helpers/world.js'

let t: TestApp
let tmp: string
let video: string

/**
 * About two minutes of talk in three topics, in sentences of roughly five seconds with a pause between them: enough for
 * highlights (15 to 60 s) and for chapters.
 */
function longTalk(): RawWord[] {
  const topics = [
    [
      'Aaj hum baat karenge funding ke baare mein.',
      'Kya aap jaante hain ki 40 lakh kaise ud gaye?',
      'Investors ko pitch deck kaise bhejein.',
      'Funding goal nahi hai, funding ek tool hai.',
      'Term sheet par sign karne se pehle lawyer se padhwaiye.',
      'Paisa tabhi ground hota hai jab product chal raha ho.',
      'Valuation ek kahani hai, number nahi.',
      'Raise karne se pehle runway ka hisaab lagaiye.',
    ],
    [
      'Ab hiring ki baat karte hain.',
      'Pehle das hire sabse zyada maayne rakhte hain.',
      'Hum ne ek designer ko teen mahine mein hire kiya.',
      'Interview mein culture se zyada kaam dekhiye.',
      'Offer letter mein equity ka hisaab saaf likhiye.',
      'Galat hire ek saal pichhe kar deta hai.',
      'Team chhoti rakhiye aur salary samay par dijiye.',
      'Payroll ki raat mujhe bahut darr laga tha.',
    ],
    [
      'Meri sabse badi galti thi ki maine bina socha kharch kiya.',
      'Chaalis lakh rupaye do mahine mein khatam ho gaye.',
      'Ek kaam jo nahi karna chahiye, wo hai bina plan ke spend.',
      'Bootstrapping ka matlab hai har rupaye ka hisaab.',
      'Cash flow positive hona sabse achha rasta hai.',
      'Ek galti se seekha ki hamesha buffer rakho.',
      'Reels aur Instagram se brand ki visibility badhaiye.',
      'Dhanyavad, milte hain agle video mein.',
    ],
  ]
  const words: RawWord[] = []
  let time = 0.5
  for (const sentence of topics.flat()) {
    const parts = sentence.split(' ')
    parts.forEach((w, i) => {
      const start = time
      time += 0.55
      words.push({ text: i === parts.length - 1 ? w : w, start, end: time })
    })
    time += 0.8
  }
  return words
}

beforeAll(async () => {
  tmp = tmpRoot()
  video = await makeSceneVideo({
    segments: [
      { color: 'red', seconds: 45 },
      { color: 'blue', seconds: 45 },
      { color: 'green', seconds: 45 },
    ],
  })
  t = await createTestApp({ TMP_DIR: tmp })
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

async function processed() {
  const person = await signup(t)
  const { projectId, done } = await fullUpload(person.c, video)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  const jobId = done.body.job.id as string
  const worker = startProcessing(
    t.deps,
    new ScriptedProvider(() => ({ language: 'hinglish', words: longTalk() })),
  )
  try {
    await waitForJob(t.deps, jobId, 'done', 120_000)
  } finally {
    await worker.close()
  }
  const [project] = await db().select().from(projects).where(eq(projects.id, projectId))
  return { ...person, projectId, jobId, project: project! }
}

/** What a stage gets, with the duration the probe stage really measured. */
async function stageContext(project: typeof projects.$inferSelect, jobId: string) {
  const [probe] = await db()
    .select()
    .from(jobStages)
    .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stage, 'probe')))
  return {
    deps: t.deps,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    project,
    prior: { probe: probe!.output },
    report: { update: async () => undefined },
    progress: () => undefined,
  } as unknown as PipelineContext
}

describe('highlights in a processed project', () => {
  it('finds about one per 90 seconds, between 3 and 12, each on sentence boundaries, 15 to 60 seconds, none overlapping', async () => {
    const { projectId, project } = await processed()
    const found = await db()
      .select()
      .from(highlights)
      .where(eq(highlights.projectId, projectId))
      .orderBy(asc(highlights.idx))
    expect(found).toHaveLength(3)
    expect(project.hooksFound).toBe(3)

    const sentenceRows = await db()
      .select()
      .from(transcriptSentences)
      .where(eq(transcriptSentences.projectId, projectId))
    const starts = new Set(sentenceRows.map((s) => s.startSec))
    const ends = new Set(sentenceRows.map((s) => s.endSec))
    for (const h of found) {
      expect(starts.has(h.startSec), `highlight starts on a sentence start (${h.startSec})`).toBe(
        true,
      )
      expect(ends.has(h.endSec), `highlight ends on a sentence end (${h.endSec})`).toBe(true)
      expect(h.endSec - h.startSec).toBeGreaterThanOrEqual(15)
      expect(h.endSec - h.startSec).toBeLessThanOrEqual(60)
      expect(h.title.length).toBeGreaterThan(0)
      expect(h.title.length).toBeLessThanOrEqual(60)
      expect(h.reason.length).toBeGreaterThan(5)
      expect(h.hookScore).toBeGreaterThanOrEqual(0)
      expect(h.hookScore).toBeLessThanOrEqual(100)
      expect(h.source).toBe('offline')
    }
    for (const a of found)
      for (const b of found)
        if (a !== b) expect(a.startSec < b.endSec && a.endSec > b.startSec).toBe(false)
    // Best first.
    expect(found.map((h) => h.hookScore)).toEqual(
      [...found.map((h) => h.hookScore)].sort((a, b) => b - a),
    )
  })

  it('reports how many hooks were found on the job, for the Processing screen', async () => {
    const { jobId } = await processed()
    const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId))
    expect(job!.found).toMatchObject({ hooks: 3 })
  })

  it('serves them through the API, best first, in the front end’s shape', async () => {
    const { c, projectId } = await processed()
    const res = await c.get(`/api/projects/${projectId}/highlights`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(3)
    expect(res.body[0]).toEqual({
      id: 'hl_0',
      title: expect.any(String),
      start: expect.any(Number),
      end: expect.any(Number),
      hookScore: expect.any(Number),
      reason: expect.any(String),
      thumbSeed: expect.any(String),
    })
    const scores = res.body.map((h: { hookScore: number }) => h.hookScore)
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a))
  })
})

describe('chapters in a processed project', () => {
  it('splits the video into 3 to 8 contiguous chapters that cover all of it, each with a short title', async () => {
    const { projectId } = await processed()
    const parts = await db()
      .select()
      .from(chapters)
      .where(eq(chapters.projectId, projectId))
      .orderBy(asc(chapters.idx))
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts.length).toBeLessThanOrEqual(8)
    expect(parts[0]!.startSec).toBe(0)
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.startSec).toBe(parts[i - 1]!.endSec)
    expect(parts.at(-1)!.endSec).toBeGreaterThan(130)
    for (const p of parts) {
      expect(p.title.length).toBeGreaterThan(0)
      expect(p.title.length).toBeLessThanOrEqual(40)
      expect(p.source).toBe('offline')
    }
  })

  it('names each scene after the chapter it starts in', async () => {
    const { projectId } = await processed()
    const parts = await db().select().from(chapters).where(eq(chapters.projectId, projectId))
    const sceneRows = await db()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.idx))
    const titles = new Set(parts.map((p) => p.title))
    expect(sceneRows.every((s) => titles.has(s.label) || /^Scene \d+$/.test(s.label))).toBe(true)
  })
})

describe('computing once', () => {
  it('makes one batched model call for highlights and one for chapters, recorded without any text', async () => {
    const { id } = await processed()
    const rows = await db().select().from(llmUsage).where(eq(llmUsage.userId, id))
    expect(rows.filter((r) => r.kind === 'highlights')).toHaveLength(1)
    expect(rows.filter((r) => r.kind === 'chapters')).toHaveLength(1)
    expect(rows.every((r) => r.outcome === 'ok')).toBe(true)
  })

  it('remembers what the transcript was, and what the results were made for', async () => {
    const { projectId } = await processed()
    const [tr] = await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
    expect(tr!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tr!.highlightsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tr!.chaptersHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('running the steps again changes nothing and calls no model', async () => {
    const { projectId, id, jobId, project } = await processed()
    const before = await db()
      .select()
      .from(highlights)
      .where(eq(highlights.projectId, projectId))
      .orderBy(asc(highlights.idx))
    const chaptersBefore = await db()
      .select()
      .from(chapters)
      .where(eq(chapters.projectId, projectId))
      .orderBy(asc(chapters.idx))
    const callsBefore = (await db().select().from(llmUsage).where(eq(llmUsage.userId, id))).length

    const ctx = await stageContext(project, jobId)
    expect(await hooks.run(ctx)).toMatchObject({ cached: true })
    expect(await chaptersStage.run(ctx)).toMatchObject({ cached: true })

    const after = await db()
      .select()
      .from(highlights)
      .where(eq(highlights.projectId, projectId))
      .orderBy(asc(highlights.idx))
    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id))
    const chaptersAfter = await db()
      .select()
      .from(chapters)
      .where(eq(chapters.projectId, projectId))
      .orderBy(asc(chapters.idx))
    expect(chaptersAfter.map((c) => c.id)).toEqual(chaptersBefore.map((c) => c.id))
    expect((await db().select().from(llmUsage).where(eq(llmUsage.userId, id))).length).toBe(
      callsBefore,
    )
  })

  it('makes them again when the transcript changes', async () => {
    const { projectId, id, jobId, project } = await processed()
    const [tr] = await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
    const ctx = await stageContext(project, jobId)
    await db()
      .update(transcripts)
      .set({ contentHash: 'a-different-transcript' })
      .where(eq(transcripts.id, tr!.id))
    const result = await hooks.run(ctx)
    expect(result).not.toHaveProperty('cached')
    expect(
      (await db().select().from(llmUsage).where(eq(llmUsage.userId, id))).filter(
        (r) => r.kind === 'highlights',
      ),
    ).toHaveLength(2)
  })
})

describe('search by meaning in a processed project', () => {
  it('stores one vector per sentence, remembers what they were made for, and records the work', async () => {
    const { projectId, id } = await processed()
    const [tr] = await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
    const sentences = await db()
      .select()
      .from(transcriptSentences)
      .where(eq(transcriptSentences.projectId, projectId))
    const vectors = await db()
      .select()
      .from(sentenceEmbeddings)
      .where(eq(sentenceEmbeddings.projectId, projectId))
    expect(vectors).toHaveLength(sentences.length)
    expect(vectors[0]!.model).toBe('hashed-words')
    expect(tr!.embeddingsHash).toContain(tr!.contentHash!)
    const usage = await db().select().from(llmUsage).where(eq(llmUsage.userId, id))
    expect(usage.filter((u) => u.kind === 'embed')).toHaveLength(1)
  })

  it('does not fail the project when the embedding service is down: search still works by words', async () => {
    const original = t.deps.embeddings
    const down = new TopicEmbeddings({})
    down.fail = new Error('embedding service down')
    t.deps.embeddings = down
    try {
      const { c, projectId, jobId } = await processed()
      const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId))
      expect(job!.status).toBe('done')
      expect(
        await db()
          .select()
          .from(sentenceEmbeddings)
          .where(eq(sentenceEmbeddings.projectId, projectId)),
      ).toEqual([])
      const [tr] = await db().select().from(transcripts).where(eq(transcripts.projectId, projectId))
      expect(tr!.embeddingsHash).toBeNull()
      const res = await c.get(`/api/projects/${projectId}/search?q=funding`)
      expect(res.status).toBe(200)
      expect(res.body.length).toBeGreaterThan(0)
      // Chapters still came out, by embedding the sentences again (or failing back to the first words).
      expect(
        (await db().select().from(chapters).where(eq(chapters.projectId, projectId))).length,
      ).toBeGreaterThanOrEqual(1)
    } finally {
      t.deps.embeddings = original
    }
  })
})
