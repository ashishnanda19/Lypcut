import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '../../src/lib/ids.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { TestClient } from '../helpers/client.js'
import { resetDatabase } from '../helpers/db.js'
import { readyProject, type ReadyProject } from '../helpers/ready.js'
import { signup, type Person } from '../helpers/world.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(() => t.close())
beforeEach(async () => {
  await resetDatabase(t.deps.database)
  await t.deps.redis.flushdb()
  await t.deps.storage.deletePrefix('users/')
})

type Setup = Person & ReadyProject
async function setup(): Promise<Setup> {
  const person = await signup(t)
  return { ...person, ...(await readyProject(t, person, { content: true })) }
}
const api = (s: Setup, path: string) => `/api/projects/${s.projectId}${path}`

describe('the transcript', () => {
  it('has the front end’s shape, word for word', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/transcript'))
    expect(res.status).toBe(200)
    const want = s.content!.transcript
    expect(res.body.language).toBe(want.language)
    expect(res.body.speakers).toEqual(want.speakers)
    expect(res.body.words).toHaveLength(want.words.length)
    expect(res.body.range).toBeUndefined()
    res.body.words.forEach((w: Record<string, unknown>, i: number) => {
      const src = want.words[i]!
      expect(w).toEqual({
        text: src.text,
        dev: src.dev,
        start: src.start,
        end: src.end,
        speaker: src.speaker,
        language: src.language,
        // `filler` is only there when true, as in the editor's own data.
        ...(src.filler ? { filler: true } : {}),
      })
    })
    expect(Object.keys(res.body.words[0]).sort()).toEqual([
      'dev',
      'end',
      'language',
      'speaker',
      'start',
      'text',
    ])
  })

  it('flags the filler words, in either script', async () => {
    const s = await setup()
    const words: Array<{ text: string; filler?: boolean }> = (await s.c.get(api(s, '/transcript')))
      .body.words
    expect(words.filter((w) => w.filler).map((w) => w.text.replace(',', ''))).toEqual([
      'um',
      'basically',
      'matlab',
    ])
    expect(words.filter((w) => 'filler' in w && w.filler !== true)).toEqual([])
  })

  it('sentences tile the words with global indices and ids like the editor’s', async () => {
    const s = await setup()
    const { sentences, words } = (await s.c.get(api(s, '/transcript'))).body
    expect(sentences[0].id).toBe('s0')
    let next = 0
    for (const sen of sentences) {
      expect(sen.from).toBe(next)
      expect(sen.to).toBeGreaterThan(sen.from)
      expect(sen.start).toBe(words[sen.from].start)
      expect(sen.end).toBe(words[sen.to - 1].end)
      next = sen.to
    }
    expect(next).toBe(words.length)
  })

  it('can be read by time range: only the words overlapping it, with indices that stay global', async () => {
    const s = await setup()
    const full = (await s.c.get(api(s, '/transcript'))).body
    const res = await s.c.get(api(s, '/transcript?from=12&to=22'))
    expect(res.status).toBe(200)
    const { words, sentences, range } = res.body
    expect(words.length).toBeGreaterThan(0)
    expect(words.length).toBeLessThan(full.words.length)
    for (const w of words) expect(w.start <= 22 && w.end >= 12).toBe(true)
    // It is a contiguous slice of the whole transcript, and says where.
    expect(range).toEqual({ from: 12, to: 22, wordOffset: expect.any(Number) })
    expect(words).toEqual(full.words.slice(range.wordOffset, range.wordOffset + words.length))
    expect(sentences.length).toBeGreaterThan(0)
    for (const sen of sentences) {
      expect(sen).toEqual(full.sentences[Number(sen.id.slice(1))])
      expect(sen.start <= 22 && sen.end >= 12).toBe(true)
    }
  })

  it('consecutive ranges together cover every word', async () => {
    const s = await setup()
    const full = (await s.c.get(api(s, '/transcript'))).body
    const seen = new Set<number>()
    for (let from = 0; from < s.content!.duration; from += 10) {
      const { words, range } = (await s.c.get(api(s, `/transcript?from=${from}&to=${from + 10}`)))
        .body
      words.forEach((_: unknown, i: number) => seen.add(range.wordOffset + i))
    }
    expect(seen.size).toBe(full.words.length)
  })

  it('a range with nothing in it is empty, not an error', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/transcript?from=9000&to=9010'))
    expect(res.status).toBe(200)
    expect(res.body.words).toEqual([])
    expect(res.body.range).toMatchObject({ wordOffset: 0 })
  })

  it('refuses a half range, a backwards range and nonsense', async () => {
    const s = await setup()
    for (const q of [
      '?from=5',
      '?to=5',
      '?from=9&to=3',
      '?from=5&to=5',
      '?from=-1&to=4',
      '?from=a&to=b',
    ]) {
      expect((await s.c.get(api(s, `/transcript${q}`))).status, q).toBe(422)
    }
  })
})

describe('scenes, highlights, chapters', () => {
  it('scenes carry ids that line up with the timeline’s clips, and a link to their thumbnail', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/scenes'))
    expect(res.status).toBe(200)
    expect(res.body.map((x: { id: string }) => x.id)).toEqual(['s0', 's1', 's2'])
    expect(res.body[0]).toMatchObject({ label: 'Intro', start: 0 })
    for (let i = 1; i < 3; i++) expect(res.body[i].start).toBe(res.body[i - 1].end)
    const thumb = await fetch(res.body[1].thumbUrl)
    expect(thumb.ok).toBe(true)
    expect(await thumb.text()).toBe('thumb-1')
  })

  it('highlights come best first with the fields the editor shows', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/highlights'))
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
    for (const h of res.body) {
      expect(Object.keys(h).sort()).toEqual([
        'end',
        'hookScore',
        'id',
        'reason',
        'start',
        'thumbSeed',
        'title',
      ])
      expect(h.id).toMatch(/^hl_\d+$/)
      expect(h.end).toBeGreaterThan(h.start)
    }
    const scores = res.body.map((h: { hookScore: number }) => h.hookScore)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('chapters start at Intro and run on without gaps', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/chapters'))
    expect(res.status).toBe(200)
    expect(res.body[0]).toMatchObject({ id: 'ch_0', title: 'Intro', start: 0 })
    for (let i = 1; i < res.body.length; i++) expect(res.body[i].start).toBe(res.body[i - 1].end)
  })

  it('summary says what was found and where the edit stands', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/summary'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      projectId: s.projectId,
      status: 'ready',
      language: 'hinglish',
      counts: {
        words: s.content!.transcript.words.length,
        sentences: s.content!.transcript.sentences.length,
        scenes: 3,
        silences: 2,
        fillers: 3,
      },
      timeline: { version: 0, lastVersion: 0 },
    })
    expect(res.body.counts.highlights).toBeGreaterThan(0)
    expect(res.body.counts.chapters).toBeGreaterThan(0)
    expect(res.body.speakers).toHaveLength(2)
    // Only ready files are counted: the pending scene clip is not.
    expect(res.body.assets).toEqual({ raw: 1, thumbnail: 3, proxy: 1 })
  })
})

describe('a project that is not ready', () => {
  it('says so, plainly, instead of returning something empty', async () => {
    const person = await signup(t)
    const created = (await person.c.post('/api/projects', { fileName: 'x.mp4' })).body.project
    for (const path of ['transcript', 'scenes', 'highlights', 'chapters', 'search?q=funding']) {
      const res = await person.c.get(`/api/projects/${created.id}/${path}`)
      expect(res.status, path).toBe(409)
      expect(res.body.error.code, path).toBe('NOT_READY')
    }
    // The summary works at any stage: that is what it is for.
    expect((await person.c.get(`/api/projects/${created.id}/summary`)).status).toBe(200)
  })
})

describe('files and their links', () => {
  it('lists the project’s files, each with a short-lived link that works for it alone', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/assets'))
    expect(res.status).toBe(200)
    expect(res.body.expiresIn).toBe(3600)
    const byKind = (k: string) => res.body.assets.filter((a: { kind: string }) => a.kind === k)
    expect(byKind('thumbnail')).toHaveLength(3)
    expect(byKind('proxy')).toHaveLength(1)

    const proxy = byKind('proxy')[0]
    expect(proxy).toMatchObject({
      label: 'Editing proxy (540p)',
      mimeType: 'video/mp4',
      width: 960,
      height: 540,
      status: 'ready',
    })
    expect(new URL(proxy.url).searchParams.get('X-Amz-Expires')).toBe('3600')
    const whole = await fetch(proxy.url)
    expect(await whole.text()).toBe('proxy-bytes')
    // Streaming works: a byte range comes back as a range.
    const part = await fetch(proxy.url, { headers: { range: 'bytes=0-4' } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('proxy')

    // A link is scoped to one file: change the path and it stops working.
    const other = new URL(proxy.url)
    other.pathname = other.pathname.replace('proxy/proxy.mp4', 'thumbs/scene-0.jpg')
    expect((await fetch(other)).status).toBe(403)
  })

  it('a file that is not ready yet has no link', async () => {
    const s = await setup()
    const res = await s.c.get(api(s, '/assets?kind=scene_clip'))
    expect(res.body.assets).toHaveLength(1)
    expect(res.body.assets[0].status).toBe('pending')
    expect(res.body.assets[0].url).toBeUndefined()
    expect((await s.c.get(api(s, `/assets/${res.body.assets[0].id}/url`))).status).toBe(409)
  })

  it('the original is offered as a download under the name the person gave it', async () => {
    const s = await setup()
    const raw = (await s.c.get(api(s, '/assets?kind=raw'))).body.assets[0]
    expect(raw.label).toBe('Funding kaise raise karein.mp4')
    const disposition = new URL(raw.url).searchParams.get('response-content-disposition')
    expect(disposition).toBe('attachment; filename="Funding kaise raise karein.mp4"')
    // The playable proxy is not a download.
    const proxy = (await s.c.get(api(s, '/assets?kind=proxy'))).body.assets[0]
    expect(new URL(proxy.url).searchParams.get('response-content-disposition')).toBeNull()
  })

  it('a long editing session can get a fresh link for one file', async () => {
    const s = await setup()
    const proxy = (await s.c.get(api(s, '/assets?kind=proxy'))).body.assets[0]
    const res = await s.c.get(api(s, `/assets/${proxy.id}/url`))
    expect(res.status).toBe(200)
    expect(res.body.expiresIn).toBe(3600)
    expect(await (await fetch(res.body.url)).text()).toBe('proxy-bytes')
  })

  it('filters by kind, and refuses a kind that does not exist', async () => {
    const s = await setup()
    expect((await s.c.get(api(s, '/assets?kind=proxy'))).body.assets).toHaveLength(1)
    expect((await s.c.get(api(s, '/assets?kind=export'))).body.assets).toEqual([])
    expect((await s.c.get(api(s, '/assets?kind=bogus'))).status).toBe(422)
  })

  it('will not hand out another project’s file, even by its id', async () => {
    const a = await setup()
    const b = await setup()
    const theirs = (await b.c.get(api(b, '/assets?kind=proxy'))).body.assets[0]
    expect((await a.c.get(api(a, `/assets/${theirs.id}/url`))).status).toBe(404)
    expect((await a.c.get(api(a, `/assets/${uuidv7()}/url`))).status).toBe(404)
    expect((await a.c.get(api(a, '/assets/not-a-uuid/url'))).status).toBe(404)
    expect((await b.c.get(api(a, `/assets/${theirs.id}/url`))).status).toBe(404)
  })

  it('points at the CDN instead of storage once one is configured', async () => {
    const cdn = await createTestApp({ CDN_BASE_URL: 'https://cdn.example.com/media/' })
    try {
      const person = await signup(cdn)
      const ready = await readyProject(cdn, person, { content: true })
      const proxy = (await person.c.get(`/api/projects/${ready.projectId}/assets?kind=proxy`)).body
        .assets[0]
      expect(proxy.url).toBe(
        `https://cdn.example.com/media/users/${person.id}/projects/${ready.projectId}/proxy/proxy.mp4`,
      )
    } finally {
      await cdn.close()
    }
  })

  it('the project list’s proxy link follows the same rules', async () => {
    const s = await setup()
    const project = (await s.c.get(`/api/projects/${s.projectId}`)).body
    const proxy = project.assets.find((a: { kind: string }) => a.kind === 'proxy')
    expect(proxy.url).toBeTruthy()
    expect(project.assets.every((a: { kind: string }) => ['raw', 'proxy'].includes(a.kind))).toBe(
      true,
    )
  })
})

describe('who can read what', () => {
  it('another user gets the same 404 as for a project that does not exist, on every read', async () => {
    const mine = await setup()
    const stranger = await signup(t)
    for (const path of [
      'transcript',
      'scenes',
      'highlights',
      'chapters',
      'summary',
      'assets',
      'search?q=funding',
    ]) {
      const real = await stranger.c.get(api(mine, `/${path}`))
      const imaginary = await stranger.c.get(`/api/projects/${uuidv7()}/${path}`)
      expect(real.status, path).toBe(404)
      expect(real.body, path).toEqual(imaginary.body)
    }
  })

  it('nobody logged in reads anything', async () => {
    const mine = await setup()
    const anon = new TestClient(t.app)
    for (const path of [
      'transcript',
      'scenes',
      'highlights',
      'chapters',
      'summary',
      'assets',
      'search?q=funding',
    ]) {
      expect((await anon.get(api(mine, `/${path}`))).status, path).toBe(401)
    }
  })

  it('no file link ever appears in a response meant for someone else', async () => {
    const mine = await setup()
    const stranger = await signup(t)
    const res = await stranger.c.get(api(mine, '/assets'))
    expect(JSON.stringify(res.body)).not.toContain('X-Amz')
  })
})
