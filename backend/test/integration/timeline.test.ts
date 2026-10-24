import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { projects, timelineOps, timelines, timelineVersions } from '../../src/db/schema/index.js'
import { uuidv7 } from '../../src/lib/ids.js'
import { sameTimeline } from '../../src/timeline-core/equality.js'
import { applyOp, sequentialIds } from '../../src/timeline-core/ops.js'
import { fromOtio, toOtio } from '../../src/timeline-core/otio.js'
import { trackItems } from '../../src/timeline-core/queries.js'
import type { Timeline, TimelineOp } from '../../src/timeline-core/types.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { captionItems, clone, prng, sampleTimeline } from '../helpers/timeline.js'
import { ORIGIN, signup, type Person } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
})

const db = () => t.deps.database.db

interface Setup extends Person, ReadyProject {}
async function setup(opts?: Parameters<typeof readyProject>[2]): Promise<Setup> {
  const person = await signup(t)
  return { ...person, ...(await readyProject(t, person, opts)) }
}

const url = (s: Setup, path = '') => `/api/projects/${s.projectId}/timeline${path}`
const ops = (s: Setup, base: number, list: TimelineOp[], label = 'Edit', extra: object = {}) =>
  s.c.post(url(s, '/ops'), { baseVersion: base, ops: list, label, ...extra })
const state = async (s: Setup) => (await s.c.get(url(s))).body
const vids = (tl: Timeline) => trackItems(tl, 'trk_video')

const readyShape = (): Timeline => sampleTimeline().timeline
const CUT: TimelineOp = { type: 'rippleDelete', from: 20, to: 50 }
const MARK = (id: string, time = 5): TimelineOp => ({
  type: 'addMarker',
  marker: { id, time, label: id },
})

describe('reading the timeline', () => {
  it('returns the current timeline with the version to send back, and nothing to undo yet', async () => {
    const s = await setup()
    const res = await s.c.get(url(s))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ version: 0, lastVersion: 0, canUndo: false, canRedo: false })
    expect(sameTimeline(res.body.timeline, s.timeline)).toBe(true)
  })

  it('says so, plainly, while a project is still being prepared', async () => {
    const person = await signup(t)
    const { c } = person
    const created = await c.post('/api/projects', { fileName: 'x.mp4' })
    const res = await c.get(`/api/projects/${created.body.project.id}/timeline`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('NOT_READY')
  })

  it('belongs to its owner alone, and needs a login', async () => {
    const mine = await setup()
    const stranger = await signup(t)
    const real = await stranger.c.get(url(mine))
    const imaginary = await stranger.c.get(`/api/projects/${uuidv7()}/timeline`)
    expect(real.status).toBe(404)
    expect(real.body).toEqual(imaginary.body)
    expect((await new TestClient(t.app).get(url(mine))).status).toBe(401)
  })
})

describe('applying ops', () => {
  it('stores a new version and returns it, with the timeline the engine produces', async () => {
    const s = await setup()
    const res = await ops(s, 0, [CUT], 'Remove the intro pause')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.version).toMatchObject({
      id: 'v_1',
      n: 1,
      parentN: 0,
      author: 'you',
      label: 'Remove the intro pause',
      current: true,
      onBranch: true,
      redoable: false,
    })
    expect(res.body.state).toMatchObject({
      version: 1,
      lastVersion: 1,
      canUndo: true,
      canRedo: false,
    })

    // The server's result is exactly what the engine gives with the server's deterministic ids.
    const expected = applyOp(s.timeline, CUT, { newId: sequentialIds('i_v1_') }).timeline
    expect(sameTimeline(res.body.state.timeline, expected)).toBe(true)
    expect(sameTimeline((await state(s)).timeline, expected)).toBe(true)
  })

  it('records the op, its inverse and the snapshot, and moves the project’s updated time', async () => {
    const s = await setup()
    const before = (await db().select().from(projects).where(eq(projects.id, s.projectId)))[0]!
      .updatedAt
    await new Promise((r) => setTimeout(r, 15))
    await ops(s, 0, [CUT], 'Cut')
    const [tl] = await db().select().from(timelines).where(eq(timelines.projectId, s.projectId))
    expect(tl).toMatchObject({ currentVersion: 1, lastVersion: 1, redoStack: [] })
    const versions = await db()
      .select()
      .from(timelineVersions)
      .where(eq(timelineVersions.timelineId, tl!.id))
    const v1 = versions.find((v) => v.n === 1)!
    expect(v1).toMatchObject({ parentN: 1 - 1, createdBy: 'user', label: 'Cut', op: CUT })
    // The stored inverse really undoes it.
    const back = applyOp(v1.snapshot as unknown as Timeline, v1.inverse as TimelineOp).timeline
    expect(sameTimeline(back, s.timeline)).toBe(true)
    const log = await db().select().from(timelineOps).where(eq(timelineOps.timelineId, tl!.id))
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ versionN: 1, seq: 0, actor: 'user', op: CUT })
    expect(
      (
        await db().select().from(projects).where(eq(projects.id, s.projectId))
      )[0]!.updatedAt.getTime(),
    ).toBeGreaterThan(before.getTime())
  })

  it('a batch of ops is one version, logged op by op, undone as one', async () => {
    const s = await setup()
    const batch = [CUT, MARK('m1'), { type: 'setCaptionStyle', styleId: 'boxed' } as TimelineOp]
    const res = await ops(s, 0, batch, 'Tidy up')
    expect(res.body.version.n).toBe(1)
    const [tl] = await db().select().from(timelines).where(eq(timelines.projectId, s.projectId))
    const [v1] = await db()
      .select()
      .from(timelineVersions)
      .where(eq(timelineVersions.timelineId, tl!.id))
      .then((r) => r.filter((x) => x.n === 1))
    expect(v1!.op).toEqual({ type: 'batch', ops: batch, label: 'Tidy up' })
    const log = await db().select().from(timelineOps).where(eq(timelineOps.timelineId, tl!.id))
    expect(log.map((l) => [l.versionN, l.seq]).sort()).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
    ])
    expect(log.every((l) => l.inverse && l.actor === 'user')).toBe(true)

    const undone = await s.c.post(url(s, '/undo'), { baseVersion: 1 })
    expect(sameTimeline(undone.body.timeline, s.timeline)).toBe(true)
  })

  it('ids for the clips an op creates depend only on the version, so they are the same every time', async () => {
    const a = await setup()
    const b = await setup()
    const split: TimelineOp = {
      type: 'split',
      itemId: vids(a.timeline)[2]!.id,
      at: vids(a.timeline)[2]!.start + 10,
    }
    const ra = await ops(a, 0, [split])
    const rb = await ops(b, 0, [{ ...split }])
    const idsOf = (tl: Timeline) =>
      Object.keys(tl.items)
        .filter((k) => k.startsWith('i_'))
        .sort()
    expect(idsOf(ra.body.state.timeline)).toEqual(['i_v1_1'])
    expect(idsOf(rb.body.state.timeline)).toEqual(['i_v1_1'])
  })

  it('records who made the change: the assistant as "ai", and the chat card that produced it', async () => {
    const s = await setup()
    const res = await ops(s, 0, [CUT], 'Remove 3 fillers', { author: 'ai', editId: 'edit_42' })
    expect(res.body.version).toMatchObject({ author: 'ai', editId: 'edit_42' })
    const [tl] = await db().select().from(timelines).where(eq(timelines.projectId, s.projectId))
    const rows = await db()
      .select()
      .from(timelineVersions)
      .where(eq(timelineVersions.timelineId, tl!.id))
    expect(rows.find((r) => r.n === 1)).toMatchObject({ createdBy: 'assistant', editId: 'edit_42' })
    const log = await db().select().from(timelineOps).where(eq(timelineOps.timelineId, tl!.id))
    expect(log[0]!.actor).toBe('assistant')
  })

  it('an assistant’s edit goes through the same checks as anyone’s', async () => {
    const s = await setup()
    const res = await ops(s, 0, [{ type: 'delete', itemIds: ['no_such_clip'] }], 'Remove it', {
      author: 'ai',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_OP')
  })
})

describe('invalid ops', () => {
  it('are refused with the engine’s own explanation and the position of the offending op', async () => {
    const s = await setup()
    const res = await ops(s, 0, [MARK('ok'), { type: 'delete', itemIds: ['nope'] }])
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({
      code: 'INVALID_OP',
      message: 'Clip nope was not found.',
      details: { opIndex: 1, opType: 'delete' },
    })
  })

  it('leave nothing behind: not the version, not the log, not even the ops before the bad one', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('fine'), { type: 'cutSource', srcFrom: 9, srcTo: 9 }])
    const [tl] = await db().select().from(timelines).where(eq(timelines.projectId, s.projectId))
    expect(tl).toMatchObject({ currentVersion: 0, lastVersion: 0 })
    expect(
      await db().select().from(timelineVersions).where(eq(timelineVersions.timelineId, tl!.id)),
    ).toHaveLength(1)
    expect(
      await db().select().from(timelineOps).where(eq(timelineOps.timelineId, tl!.id)),
    ).toHaveLength(0)
    expect(sameTimeline((await state(s)).timeline, s.timeline)).toBe(true)
  })

  const refusals: Array<[string, TimelineOp, RegExp]> = [
    ['an overlap', { type: 'move', itemId: vids(readyShape())[1]!.id, start: 1 }, /overlap/],
    [
      'a clip on a track it does not fit',
      { type: 'move', itemId: vids(readyShape())[1]!.id, start: 100, trackId: 'trk_audio' },
      /belong/,
    ],
    ['a crop outside the frame', { type: 'setCrop', crop: { x: 3, y: 0.5, scale: 1 } }, /frame/],
    ['an impossible zoom', { type: 'setCrop', crop: { x: 0.5, y: 0.5, scale: 9 } }, /zoom/i],
    [
      'a split off the clip',
      { type: 'split', itemId: vids(readyShape())[0]!.id, at: 9999 },
      /playhead/,
    ],
    [
      'restoring footage that does not exist',
      { type: 'restoreSource', srcFrom: 0, srcTo: 99999 },
      /does not exist/,
    ],
    [
      'a patch onto a track that is not there',
      {
        type: 'patch',
        upsert: [{ ...vids(readyShape())[0]!, id: 'p', trackId: 'ghost' }],
        remove: [],
      },
      /does not exist/,
    ],
  ]
  for (const [name, op, message] of refusals) {
    it(`${name}`, async () => {
      const s = await setup()
      const res = await ops(s, 0, [op])
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('INVALID_OP')
      expect(res.body.error.message).toMatch(message)
      expect((await state(s)).version).toBe(0)
    })
  }

  it('malformed requests are a validation error, never a server error', async () => {
    const s = await setup()
    const bad: Array<[string, object]> = [
      ['no ops', { baseVersion: 0, ops: [], label: 'x' }],
      ['unknown op type', { baseVersion: 0, ops: [{ type: 'launch' }], label: 'x' }],
      [
        'an extra field on an op',
        { baseVersion: 0, ops: [{ ...MARK('a'), extra: 1 }], label: 'x' },
      ],
      [
        'NaN-ish time',
        {
          baseVersion: 0,
          ops: [{ type: 'trim', itemId: 'v', edge: 'end', to: 'soon' }],
          label: 'x',
        },
      ],
      ['no label', { baseVersion: 0, ops: [MARK('a')] }],
      ['a blank label', { baseVersion: 0, ops: [MARK('a')], label: '   ' }],
      ['a bad author', { baseVersion: 0, ops: [MARK('a')], label: 'x', author: 'admin' }],
      ['a missing base version', { ops: [MARK('a')], label: 'x' }],
      ['a negative base version', { baseVersion: -1, ops: [MARK('a')], label: 'x' }],
      [
        'too many ops',
        { baseVersion: 0, ops: Array.from({ length: 201 }, (_, i) => MARK(`m${i}`)), label: 'x' },
      ],
    ]
    for (const [name, body] of bad) {
      const res = await s.c.post(url(s, '/ops'), body)
      expect(res.status, name).toBe(422)
      expect(res.body.error.code, name).toBe('VALIDATION_ERROR')
    }
  })

  it('a payload nested thousands of levels deep is refused, not a crash', async () => {
    const s = await setup()
    // Built as text: a JS object this deep would overflow the test's own JSON.stringify.
    const depth = 4000
    const body =
      `{"baseVersion":0,"label":"deep","ops":[` +
      '{"type":"batch","ops":['.repeat(depth) +
      '{"type":"addMarker","marker":{"id":"d","time":1,"label":"d"}}' +
      ']}'.repeat(depth) +
      ']}'
    const res = await s.c.request('POST', url(s, '/ops'), body, {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // And the server is still fine.
    expect((await s.c.get(url(s))).status).toBe(200)
  })

  it('cannot smuggle extra fields into the stored timeline through an item', async () => {
    const s = await setup()
    const item = { ...captionItems(0, 1)[0]!, isAdmin: true }
    const res = await ops(s, 0, [{ type: 'addCaptions', items: [item] } as TimelineOp])
    expect(res.status).toBe(422)
    expect(JSON.stringify((await state(s)).timeline)).not.toContain('isAdmin')
  })
})

describe('two windows editing at once', () => {
  it('an edit based on an old version is refused with a conflict that says where things stand', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('first')])
    const stale = await ops(s, 0, [MARK('second')])
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 1, lastVersion: 1, baseVersion: 0 },
    })
    expect((await state(s)).timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual([
      'first',
    ])
  })

  it('two edits sent at the same moment on the same version: exactly one wins', async () => {
    const s = await setup()
    const [a, b] = await Promise.all([ops(s, 0, [MARK('a')]), ops(s, 0, [MARK('b')])])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await state(s)).version).toBe(1)
    expect((await state(s)).timeline.settings.markers).toHaveLength(1)
  })

  it('many clients retrying until they get in all succeed, and the history has no gaps or repeats', async () => {
    const s = await setup()
    const clients = 6
    const retry = async (id: string) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const base = (await state(s)).version
        const res = await ops(s, base, [MARK(id)], `Mark ${id}`)
        if (res.status === 200) return res.body.version.n as number
        expect(res.status).toBe(409)
      }
      throw new Error('never got in')
    }
    const numbers = await Promise.all(Array.from({ length: clients }, (_, i) => retry(`c${i}`)))
    expect(numbers.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6])
    const final = await state(s)
    expect(final.version).toBe(6)
    expect(final.timeline.settings.markers.map((m: { id: string }) => m.id).sort()).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
      'c4',
      'c5',
    ])
  })

  it('different projects never block or conflict with one another', async () => {
    const a = await setup()
    const b = await setup()
    const [ra, rb] = await Promise.all([ops(a, 0, [MARK('x')]), ops(b, 0, [MARK('x')])])
    expect([ra.status, rb.status]).toEqual([200, 200])
  })
})

describe('undo and redo', () => {
  it('step back and forward through the history, with the right flags at every step', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('one')], 'One')
    await ops(s, 1, [MARK('two')], 'Two')
    await ops(s, 2, [MARK('three')], 'Three')
    expect(await state(s)).toMatchObject({
      version: 3,
      lastVersion: 3,
      canUndo: true,
      canRedo: false,
    })

    const u1 = (await s.c.post(url(s, '/undo'), { baseVersion: 3 })).body
    expect(u1).toMatchObject({ version: 2, lastVersion: 3, canUndo: true, canRedo: true })
    expect(u1.timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual(['one', 'two'])
    const u2 = (await s.c.post(url(s, '/undo'), { baseVersion: 2 })).body
    expect(u2).toMatchObject({ version: 1, canUndo: true, canRedo: true })
    const u3 = (await s.c.post(url(s, '/undo'), { baseVersion: 1 })).body
    expect(u3).toMatchObject({ version: 0, canUndo: false, canRedo: true })
    expect(sameTimeline(u3.timeline, s.timeline)).toBe(true)

    const r1 = (await s.c.post(url(s, '/redo'), { baseVersion: 0 })).body
    expect(r1).toMatchObject({ version: 1, canUndo: true, canRedo: true })
    const r2 = (await s.c.post(url(s, '/redo'), { baseVersion: 1 })).body
    const r3 = (await s.c.post(url(s, '/redo'), { baseVersion: 2 })).body
    expect(r3).toMatchObject({ version: 3, canUndo: true, canRedo: false })
    expect(r2.version).toBe(2)
    // And what you see after undo and redo is exactly what was there.
    expect((await state(s)).timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('refuses to undo past the start and to redo with nothing to redo', async () => {
    const s = await setup()
    const undo = await s.c.post(url(s, '/undo'), { baseVersion: 0 })
    expect(undo.status).toBe(409)
    expect(undo.body.error.message).toMatch(/nothing to undo/i)
    const redo = await s.c.post(url(s, '/redo'), { baseVersion: 0 })
    expect(redo.status).toBe(409)
    expect(redo.body.error.message).toMatch(/nothing to redo/i)
  })

  it('refuse a stale base version like any edit does', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')])
    const res = await s.c.post(url(s, '/undo'), { baseVersion: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
  })

  it('a new edit after an undo starts a fresh branch: redo is gone, but nothing is lost', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')], 'A')
    await ops(s, 1, [MARK('b')], 'B')
    await s.c.post(url(s, '/undo'), { baseVersion: 2 }) // back at version 1
    const fresh = await ops(s, 1, [MARK('c')], 'C')
    expect(fresh.body.version).toMatchObject({ n: 3, parentN: 1 })
    expect(fresh.body.state).toMatchObject({ version: 3, lastVersion: 3, canRedo: false })
    expect((await s.c.post(url(s, '/redo'), { baseVersion: 3 })).status).toBe(409)

    const history = (await s.c.get(url(s, '/history'))).body
    const byN = Object.fromEntries(history.versions.map((v: { n: number }) => [v.n, v]))
    // Version 2 ("B") is off the current path but still there.
    expect(byN[2]).toMatchObject({ label: 'B', onBranch: false, current: false })
    expect(byN[3]).toMatchObject({ label: 'C', onBranch: true, current: true })
    expect(byN[1].onBranch).toBe(true)
    // It can still be fetched in full, and restored.
    const old = (await s.c.get(url(s, '/versions/2'))).body
    expect(old.timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual(['a', 'b'])
  })

  it('an undone version is marked redoable until a new edit replaces it', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')])
    await ops(s, 1, [MARK('b')])
    await s.c.post(url(s, '/undo'), { baseVersion: 2 })
    const before = (await s.c.get(url(s, '/history'))).body.versions.find(
      (v: { n: number }) => v.n === 2,
    )
    expect(before).toMatchObject({ redoable: true, onBranch: false })
    await ops(s, 1, [MARK('c')])
    const after = (await s.c.get(url(s, '/history'))).body.versions.find(
      (v: { n: number }) => v.n === 2,
    )
    expect(after.redoable).toBe(false)
  })

  it('a stale redo stack is discarded rather than followed', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')])
    await ops(s, 1, [MARK('b')])
    await s.c.post(url(s, '/undo'), { baseVersion: 2 })
    // Corrupt the stack to point at a version that is not a child of where we are.
    await db()
      .update(timelines)
      .set({ redoStack: [1] })
      .where(eq(timelines.projectId, s.projectId))
    const res = await s.c.post(url(s, '/redo'), { baseVersion: 1 })
    expect(res.status).toBe(409)
    expect(await state(s)).toMatchObject({ version: 1, canRedo: false })
  })
})

describe('history', () => {
  async function history(s: Setup, query = '') {
    return (await s.c.get(url(s, `/history${query}`))).body
  }

  it('lists the versions newest first, with who made each one and when, and without snapshots', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')], 'Add a marker')
    await ops(s, 1, [CUT], 'Remove filler words', { author: 'ai', editId: 'e1' })
    const h = await history(s)
    expect(h.current).toBe(2)
    expect(h.hasMore).toBe(false)
    expect(h.versions.map((v: { n: number }) => v.n)).toEqual([2, 1, 0])
    expect(h.versions[0]).toMatchObject({
      id: 'v_2',
      label: 'Remove filler words',
      author: 'ai',
      editId: 'e1',
      current: true,
      onBranch: true,
      parentN: 1,
    })
    expect(h.versions[2]).toMatchObject({
      id: 'v_0',
      label: 'Original upload',
      author: 'you',
      parentN: null,
    })
    expect(typeof h.versions[0].at).toBe('number')
    // The panel lists many of these, so nothing heavy comes with them.
    expect(JSON.stringify(h)).not.toMatch(/"items"|"snapshot"|"timeline"/)
  })

  it('pages back through a long history', async () => {
    const s = await setup()
    for (let i = 0; i < 12; i++) await ops(s, i, [MARK(`m${i}`)], `Edit ${i}`)
    const first = await history(s, '?limit=5')
    expect(first.versions.map((v: { n: number }) => v.n)).toEqual([12, 11, 10, 9, 8])
    expect(first.hasMore).toBe(true)
    const second = await history(s, '?limit=5&before=8')
    expect(second.versions.map((v: { n: number }) => v.n)).toEqual([7, 6, 5, 4, 3])
    const last = await history(s, '?limit=5&before=3')
    expect(last.versions.map((v: { n: number }) => v.n)).toEqual([2, 1, 0])
    expect(last.hasMore).toBe(false)
    expect((await s.c.get(url(s, '/history?limit=0'))).status).toBe(422)
    expect((await s.c.get(url(s, '/history?limit=9999'))).status).toBe(422)
  })

  it('returns one version in full: what it did, how to undo it, and the timeline after it', async () => {
    const s = await setup()
    await ops(s, 0, [CUT], 'Cut')
    await ops(s, 1, [MARK('a')], 'Mark')
    const v1 = (await s.c.get(url(s, '/versions/1'))).body
    expect(v1.version).toMatchObject({ n: 1, label: 'Cut', onBranch: true, current: false })
    expect(v1.op).toEqual(CUT)
    const expected = applyOp(s.timeline, CUT, { newId: sequentialIds('i_v1_') }).timeline
    expect(sameTimeline(v1.timeline, expected)).toBe(true)
    expect(sameTimeline(applyOp(v1.timeline, v1.inverse).timeline, s.timeline)).toBe(true)
    expect((await s.c.get(url(s, '/versions/99'))).status).toBe(404)
    expect((await s.c.get(url(s, '/versions/abc'))).status).toBe(422)
  })

  it('belongs to the project’s owner', async () => {
    const mine = await setup()
    const stranger = await signup(t)
    expect((await stranger.c.get(url(mine, '/history'))).status).toBe(404)
    expect((await stranger.c.get(url(mine, '/versions/0'))).status).toBe(404)
  })
})

describe('restoring an earlier version', () => {
  it('becomes a new version that looks like the old one, and loses nothing', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')], 'Add a')
    await ops(s, 1, [CUT], 'Cut the middle')
    await ops(s, 2, [MARK('b')], 'Add b')
    const v1 = (await s.c.get(url(s, '/versions/1'))).body.timeline

    const res = await s.c.post(url(s, '/restore'), { baseVersion: 3, versionN: 1 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.version).toMatchObject({
      n: 4,
      parentN: 3,
      label: 'Restored: Add a',
      author: 'you',
      current: true,
    })
    expect(sameTimeline(res.body.state.timeline, v1)).toBe(true)

    // Everything before is still there.
    const h = (await s.c.get(url(s, '/history'))).body
    expect(h.versions.map((v: { n: number }) => v.n)).toEqual([4, 3, 2, 1, 0])
    // And the restore can itself be undone.
    const undone = (await s.c.post(url(s, '/undo'), { baseVersion: 4 })).body
    expect(undone.version).toBe(3)
    expect(undone.timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual(['a', 'b'])
  })

  it('can go back to the very first version', async () => {
    const s = await setup()
    await ops(s, 0, [CUT], 'Cut')
    const res = await s.c.post(url(s, '/restore'), { baseVersion: 1, versionN: 0 })
    expect(res.status).toBe(200)
    expect(sameTimeline(res.body.state.timeline, s.timeline)).toBe(true)
    expect(res.body.version.label).toBe('Restored: Original upload')
  })

  it('refuses when it is already how the edit looks, when the version is unknown, and when the base is stale', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')])
    const same = await s.c.post(url(s, '/restore'), { baseVersion: 1, versionN: 1 })
    expect(same.status).toBe(409)
    expect(same.body.error.message).toMatch(/already how the edit looks/i)
    expect((await s.c.post(url(s, '/restore'), { baseVersion: 1, versionN: 77 })).status).toBe(404)
    expect(
      (await s.c.post(url(s, '/restore'), { baseVersion: 0, versionN: 0 })).body.error.code,
    ).toBe('VERSION_CONFLICT')
  })

  it('works across branches: back to a version that was abandoned', async () => {
    const s = await setup()
    await ops(s, 0, [MARK('a')], 'A')
    await ops(s, 1, [MARK('b')], 'B')
    await s.c.post(url(s, '/undo'), { baseVersion: 2 })
    await ops(s, 1, [MARK('c')], 'C') // abandons B
    const res = await s.c.post(url(s, '/restore'), { baseVersion: 3, versionN: 2 })
    expect(res.status).toBe(200)
    expect(res.body.state.timeline.settings.markers.map((m: { id: string }) => m.id)).toEqual([
      'a',
      'b',
    ])
  })
})

describe('OpenTimelineIO export', () => {
  it('downloads the current timeline as a .otio file that reads back to exactly that timeline', async () => {
    const s = await setup({ title: 'Funding kaise raise karein', fileName: 'ep42.mp4' })
    await ops(
      s,
      0,
      [CUT, { type: 'addCaptions', items: captionItems(0, 10) }, MARK('hook', 12)],
      'Edit',
    )
    const res = await s.c.get(`/api/projects/${s.projectId}/export/otio`)
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/)
    expect(String(res.headers['content-disposition'])).toMatch(
      /^attachment; filename="Funding kaise raise karein\.otio"/,
    )
    expect(res.headers['cache-control']).toBe('no-store')

    const doc = res.body
    expect(doc.OTIO_SCHEMA).toBe('Timeline.1')
    expect(doc.name).toBe('Funding kaise raise karein')
    const current = (await state(s)).timeline
    expect(doc).toEqual(
      JSON.parse(JSON.stringify(toOtio(current, 'Funding kaise raise karein', 'media/ep42.mp4'))),
    )
    // The clips point at the original's file name, for relinking in an editor.
    const clip = doc.tracks.children
      .find((tr: { name: string }) => tr.name === 'Video')
      .children.find((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA === 'Clip.2')
    expect(clip.media_reference.target_url).toBe('media/ep42.mp4')

    // The round trip: the file read back is the edit, to the last detail.
    expect(sameTimeline(fromOtio(doc).timeline, current)).toBe(true)
  })

  it('reflects the edit: a cut makes the exported video shorter by exactly that much', async () => {
    const s = await setup()
    const frames = (doc: {
      tracks: {
        children: Array<{
          name: string
          children: Array<{ OTIO_SCHEMA: string; source_range: { duration: { value: number } } }>
        }>
      }
    }) =>
      doc.tracks.children
        .find((tr) => tr.name === 'Video')!
        .children.filter((c) => c.OTIO_SCHEMA === 'Clip.2')
        .reduce((sum, c) => sum + c.source_range.duration.value, 0)
    const before = frames((await s.c.get(`/api/projects/${s.projectId}/export/otio`)).body)
    await ops(s, 0, [CUT], 'Cut 30s')
    const after = frames((await s.c.get(`/api/projects/${s.projectId}/export/otio`)).body)
    expect((before - after) / 30).toBeCloseTo(30, 0)
    // After an undo it is the longer one again.
    await s.c.post(url(s, '/undo'), { baseVersion: 1 })
    expect(frames((await s.c.get(`/api/projects/${s.projectId}/export/otio`)).body)).toBe(before)
  })

  it('names a download safely when the title is in Hindi or has awkward characters', async () => {
    const s = await setup({ title: 'फंडिंग कैसे "raise" करें / 2024' })
    const res = await s.c.get(`/api/projects/${s.projectId}/export/otio`)
    const disposition = String(res.headers['content-disposition'])
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+\.otio"; filename\*=UTF-8''/)
    expect(disposition).not.toMatch(/"[^"]*"[^;]*"[^"]*"\.otio/)
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(
      'फंडिंग कैसे "raise" करें / 2024.otio',
    )
  })

  it('belongs to the owner, needs a login, and says so for a project that is not ready', async () => {
    const mine = await setup()
    const stranger = await signup(t)
    expect((await stranger.c.get(`/api/projects/${mine.projectId}/export/otio`)).status).toBe(404)
    expect(
      (
        await new TestClient(t.app, { headers: { origin: ORIGIN } }).get(
          `/api/projects/${mine.projectId}/export/otio`,
        )
      ).status,
    ).toBe(401)
    const created = (await mine.c.post('/api/projects', { fileName: 'x.mp4' })).body.project
    expect((await mine.c.get(`/api/projects/${created.id}/export/otio`)).status).toBe(409)
  })
})

describe('the server and a client that mirrors it never disagree (model-based)', () => {
  /**
   * A local model of what the server should be doing, driven by the same random actions. After every step the
   * server's state must equal the model's: the timeline, the version number, and whether undo and redo are open.
   */
  for (const seed of [31, 32, 33]) {
    it(`seed ${seed}: 90 random edits, undos, redos and restores`, async () => {
      const s = await setup()
      const rand = prng(seed)
      const snapshots = new Map<number, Timeline>([[0, s.timeline]])
      const parent = new Map<number, number | null>([[0, null]])
      let current = 0
      let last = 0
      let redo: number[] = []
      let lastRestore = -1
      const counts = { op: 0, refused: 0, undo: 0, redo: 0, restore: 0 }

      for (let step = 0; step < 90; step++) {
        const roll = rand()
        let action = 'op'
        if (roll < 0.55) {
          // An edit: sometimes valid, sometimes not.
          const tl = snapshots.get(current)!
          const clips = Object.values(tl.items).filter((i) => i.kind === 'video')
          const clip = clips[Math.floor(rand() * clips.length)] ?? Object.values(tl.items)[0]!
          const candidates: TimelineOp[] = [
            {
              type: 'split',
              itemId: clip.id,
              at: clip.start + clip.duration * (0.2 + rand() * 0.6),
            },
            { type: 'trim', itemId: clip.id, edge: 'end', to: clip.start + clip.duration * rand() },
            { type: 'rippleDelete', from: rand() * 200, to: rand() * 200 + 2 },
            { type: 'cutSource', srcFrom: rand() * 250, srcTo: rand() * 250 + 3 },
            { type: 'addMarker', marker: { id: `mk${step}`, time: rand() * 200, label: 'm' } },
            { type: 'setCrop', crop: { x: rand() * 1.2, y: rand(), scale: 0.8 + rand() * 3.4 } },
            { type: 'delete', itemIds: ['nope'] },
          ]
          const op = candidates[Math.floor(rand() * candidates.length)]!
          const res = await ops(s, current, [op], `step ${step}`)
          let expected: Timeline | null = null
          try {
            expected = applyOp(tl, op, { newId: sequentialIds(`i_v${last + 1}_`) }).timeline
          } catch {
            expected = null
          }
          if (expected === null) {
            expect(res.status, JSON.stringify(op)).toBe(422)
            counts.refused++
          } else {
            expect(res.status, JSON.stringify(res.body)).toBe(200)
            last += 1
            snapshots.set(last, expected)
            parent.set(last, current)
            current = last
            redo = []
            counts.op++
          }
        } else if (roll < 0.72) {
          action = 'undo'
          const res = await s.c.post(url(s, '/undo'), { baseVersion: current })
          const p = parent.get(current)
          if (p === null || p === undefined) expect(res.status).toBe(409)
          else {
            expect(res.status).toBe(200)
            redo.push(current)
            current = p
            counts.undo++
          }
        } else if (roll < 0.86) {
          action = 'redo'
          const res = await s.c.post(url(s, '/redo'), { baseVersion: current })
          if (!redo.length) expect(res.status).toBe(409)
          else {
            expect(res.status).toBe(200)
            current = redo.pop()!
            counts.redo++
          }
        } else {
          action = 'restore'
          const n = Math.floor(rand() * (last + 1))
          lastRestore = n
          const res = await s.c.post(url(s, '/restore'), { baseVersion: current, versionN: n })
          if (sameTimeline(snapshots.get(n)!, snapshots.get(current)!)) expect(res.status).toBe(409)
          else {
            expect(res.status, JSON.stringify(res.body)).toBe(200)
            last += 1
            snapshots.set(last, clone(snapshots.get(n)!))
            parent.set(last, current)
            current = last
            redo = []
            counts.restore++
          }
        }
        // After every step the server agrees with the model.
        const server = await state(s)
        expect(server.version, `step ${step}`).toBe(current)
        expect(server.lastVersion, `step ${step}`).toBe(last)
        expect(server.canUndo).toBe((parent.get(current) ?? null) !== null)
        expect(server.canRedo).toBe(redo.length > 0)
        expect(
          sameTimeline(server.timeline, snapshots.get(current)!),
          `step ${step} (${action}, current ${current}, restore target ${lastRestore})`,
        ).toBe(true)
      }
      // The run really did exercise all of it.
      expect(counts.op).toBeGreaterThan(10)
      expect(counts.refused).toBeGreaterThan(0)
      expect(counts.undo + counts.redo).toBeGreaterThan(5)
    }, 120_000)
  }
})
