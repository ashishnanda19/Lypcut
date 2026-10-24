import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROUTE_SUMMARIES } from '../../src/app/plugins/docs.js'
import { createTestApp, type TestApp } from '../helpers/app.js'

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
  await t.app.ready()
})
afterAll(() => t.close())

type Operation = { summary?: string; tags?: string[] }
const spec = () =>
  t.app.swagger() as unknown as { paths: Record<string, Record<string, Operation>> }

/** OpenAPI writes `{id}`; the code and the docs write `:id`. The module routes are served under /api. */
const normal = (path: string) => path.replace(/\{(\w+)\}/g, ':$1')
const HTTP = new Set(['get', 'post', 'patch', 'put', 'delete'])

function operations() {
  const out: Array<{ key: string; op: Operation }> = []
  for (const [path, item] of Object.entries(spec().paths))
    for (const [method, op] of Object.entries(item))
      if (HTTP.has(method)) out.push({ key: `${method.toUpperCase()} ${normal(path)}`, op })
  return out
}

describe('the generated API reference', () => {
  it('describes every endpoint with a summary and a tag', () => {
    const missing = operations().filter(({ op }) => !op.summary || !op.tags?.length)
    expect(missing.map((m) => m.key)).toEqual([])
  })

  it('has no summaries for endpoints that do not exist', () => {
    // Summaries are keyed by full URL (`/api/...`), the spec by path without the /api server prefix.
    const real = new Set(
      operations().map(({ key }) => {
        const [method, path] = key.split(' ')
        return `${method} ${path!.startsWith('/health') || path!.startsWith('/ready') ? path : `/api${path}`}`
      }),
    )
    const stale = Object.keys(ROUTE_SUMMARIES).filter((k) => !real.has(k))
    expect(stale).toEqual([])
  })
})

describe('API.md', () => {
  const doc = readFileSync(new URL('../../API.md', import.meta.url), 'utf8')
  const documented = new Set(
    [...doc.matchAll(/^### (GET|POST|PATCH|PUT|DELETE) (\S+)$/gm)]
      // The live feed is a WebSocket, which OpenAPI cannot describe.
      .filter((m) => m[1] !== 'GET' || !m[2]!.endsWith('/jobs/ws'))
      .map((m) => `${m[1]} ${normal(m[2]!.replace(/\{(\w+)\}/g, '{$1}'))}`),
  )

  it('documents every endpoint that exists', () => {
    const real = operations().map(({ key }) => key)
    expect(real.filter((k) => !documented.has(k))).toEqual([])
  })

  it('documents no endpoint that does not exist', () => {
    const real = new Set(operations().map(({ key }) => key))
    expect([...documented].filter((k) => !real.has(k))).toEqual([])
  })
})
