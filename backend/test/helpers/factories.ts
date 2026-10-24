import { eq } from 'drizzle-orm'
import type { Database } from '../../src/db/client.js'
import {
  assets,
  chapters,
  highlights,
  jobs,
  jobStages,
  projects,
  scenes,
  sessions,
  silences,
  timelineOps,
  timelines,
  timelineVersions,
  transcriptSentences,
  transcriptWords,
  transcripts,
  uploads,
  usageEvents,
  llmUsage,
  userPreferences,
  users,
} from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'

let counter = 0
const next = () => ++counter

export async function makeUser(
  database: Database,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  const n = next()
  const [user] = await database.db
    .insert(users)
    .values({
      email: `user${n}-${uuidv7().slice(-8)}@example.com`,
      name: `User ${n}`,
      ...overrides,
    })
    .returning()
  await database.db.insert(userPreferences).values({ userId: user!.id })
  return user!
}

export async function makeProject(
  database: Database,
  ownerId: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
) {
  const [project] = await database.db
    .insert(projects)
    .values({ ownerId, title: `Project ${next()}`, thumbSeed: uuidv7(), ...overrides })
    .returning()
  return project!
}

/** A project with a row in every table that hangs off a project, to test cascades. */
export async function makeFullProject(database: Database, ownerId: string) {
  const { db } = database
  const project = await makeProject(database, ownerId, { status: 'ready', durationSec: 60 })
  const [raw] = await db
    .insert(assets)
    .values({
      projectId: project.id,
      kind: 'raw',
      storageKey: `users/${ownerId}/projects/${project.id}/raw/${uuidv7()}.mp4`,
      label: 'raw',
    })
    .returning()
  const [scene] = await db
    .insert(scenes)
    .values({ projectId: project.id, idx: 0, label: 'Intro', startSec: 0, endSec: 12 })
    .returning()
  await db.update(assets).set({ sceneId: scene!.id }).where(eq(assets.id, raw!.id))
  await db.update(scenes).set({ thumbnailAssetId: raw!.id }).where(eq(scenes.id, scene!.id))
  await db.insert(uploads).values({
    userId: ownerId,
    projectId: project.id,
    assetId: raw!.id,
    fileName: 'a.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1000,
    storageKey: raw!.storageKey,
    s3UploadId: 'upload-id',
    partSize: 5 * 1024 * 1024,
    totalParts: 1,
    expiresAt: new Date(Date.now() + 3600_000),
  })
  const [tr] = await db
    .insert(transcripts)
    .values({ projectId: project.id, language: 'hinglish', provider: 'test', wordCount: 2 })
    .returning()
  await db.insert(transcriptWords).values([
    {
      transcriptId: tr!.id,
      projectId: project.id,
      idx: 0,
      text: 'funding',
      dev: 'फंडिंग',
      norm: 'funding',
      startSec: 0,
      endSec: 0.5,
      speaker: 's1',
      language: 'en',
    },
    {
      transcriptId: tr!.id,
      projectId: project.id,
      idx: 1,
      text: 'kaise',
      dev: 'कैसे',
      norm: 'kaise',
      startSec: 0.5,
      endSec: 0.9,
      speaker: 's1',
      language: 'hi',
    },
  ])
  await db.insert(transcriptSentences).values({
    transcriptId: tr!.id,
    projectId: project.id,
    idx: 0,
    speaker: 's1',
    fromWord: 0,
    toWord: 2,
    startSec: 0,
    endSec: 0.9,
    text: 'funding kaise',
    dev: 'फंडिंग कैसे',
    norm: 'funding kaise',
  })
  await db.insert(highlights).values({
    projectId: project.id,
    idx: 0,
    title: 'Hook',
    startSec: 1,
    endSec: 9,
    hookScore: 80,
    reason: 'Strong claim',
    thumbSeed: 'h',
  })
  await db
    .insert(chapters)
    .values({ projectId: project.id, idx: 0, title: 'Start', startSec: 0, endSec: 30 })
  await db.insert(silences).values({ projectId: project.id, startSec: 3, endSec: 4.2 })
  const [tl] = await db
    .insert(timelines)
    .values({ projectId: project.id, sourceDuration: 60 })
    .returning()
  await db.insert(timelineVersions).values({
    timelineId: tl!.id,
    n: 0,
    createdBy: 'user',
    label: 'Original upload',
    snapshot: {},
    op: {},
    inverse: {},
  })
  await db.insert(timelineOps).values({
    timelineId: tl!.id,
    versionN: 0,
    seq: 0,
    actor: 'user',
    op: {},
    inverse: {},
  })
  const [job] = await db
    .insert(jobs)
    .values({ userId: ownerId, projectId: project.id, type: 'processing' })
    .returning()
  await db.insert(jobStages).values({ jobId: job!.id, stage: 'probe' })
  await db
    .insert(usageEvents)
    .values({ userId: ownerId, kind: 'upload', amount: 1, projectId: project.id })
  await db.insert(llmUsage).values({
    userId: ownerId,
    projectId: project.id,
    kind: 'planner',
    provider: 'fake',
    model: 'fake',
    outcome: 'ok',
  })
  await db.insert(sessions).values({
    userId: ownerId,
    tokenHash: uuidv7(),
    familyId: uuidv7(),
    expiresAt: new Date(Date.now() + 3600_000),
  })
  return { project, raw: raw!, scene: scene!, transcript: tr!, timeline: tl!, job: job! }
}
