import { assets, projects, timelines, timelineVersions } from '../../src/db/schema/index.js'
import type { Timeline } from '../../src/timeline-core/types.js'
import type { TestApp } from './app.js'
import { sampleTimeline } from './timeline.js'
import type { Person } from './world.js'

export interface ReadyProject {
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
  opts: { title?: string; fileName?: string } = {},
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
  return { projectId: project!.id, timeline: sample.timeline, words: sample.words }
}
