import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import { jsonSchemaTransform } from 'fastify-type-provider-zod'

/** One line per endpoint, shown in /docs. A test fails if a route is missing from this list. */
export const ROUTE_SUMMARIES: Record<string, string> = {
  'GET /health': 'Is the process up (no dependencies checked).',
  'GET /ready': 'Are Postgres, Redis and storage reachable. Used by load balancers.',

  'POST /api/auth/signup': 'Create an account and sign in.',
  'POST /api/auth/login': 'Sign in with email and password.',
  'POST /api/auth/refresh':
    'Trade the refresh token for a new session. Each refresh token works once.',
  'POST /api/auth/logout': 'End this session.',
  'POST /api/auth/google': 'Not available yet (answers 501).',

  'GET /api/me': 'The signed-in person.',
  'PATCH /api/me': 'Change name, language or content type, or finish onboarding.',
  'DELETE /api/me': 'Delete the account and everything that belongs to it.',

  'GET /api/projects': 'The person’s projects, newest first.',
  'POST /api/projects': 'Create an empty project to upload a video into.',
  'GET /api/projects/:id': 'One project, with its original and editing-copy files.',
  'PATCH /api/projects/:id': 'Rename a project.',
  'DELETE /api/projects/:id': 'Delete a project and its files.',

  'POST /api/uploads': 'Start (or resume) the upload of a video into a project.',
  'GET /api/uploads/:id': 'Which parts storage already holds.',
  'DELETE /api/uploads/:id': 'Abandon an upload and free its parts.',
  'POST /api/uploads/:id/parts': 'Short-lived links to send parts straight to storage.',
  'POST /api/uploads/:id/complete': 'Check the file and start processing.',

  'GET /api/projects/:id/timeline':
    'The current timeline and the version to send with the next edit.',
  'POST /api/projects/:id/timeline/ops': 'Apply edits as one new version.',
  'POST /api/projects/:id/timeline/undo': 'Step back one version.',
  'POST /api/projects/:id/timeline/redo': 'Step forward one version.',
  'GET /api/projects/:id/timeline/history': 'Versions, newest first, without their snapshots.',
  'GET /api/projects/:id/timeline/versions/:n': 'One version in full.',
  'POST /api/projects/:id/timeline/restore': 'Become an earlier version, as a new version.',
  'GET /api/projects/:id/export/otio': 'The current timeline as an OpenTimelineIO file.',

  'GET /api/projects/:id/transcript': 'Words, speakers and sentences, optionally for a time range.',
  'GET /api/projects/:id/scenes': 'Scene boundaries, with thumbnail links.',
  'GET /api/projects/:id/highlights': 'Moments likely to hook a viewer, best first.',
  'GET /api/projects/:id/chapters': 'Chapters of the video.',
  'GET /api/projects/:id/summary': 'Counts of what was found, in one call.',
  'GET /api/projects/:id/assets': 'The project’s files, each with a short-lived link.',
  'GET /api/projects/:id/assets/:assetId/url': 'A fresh link for one file.',
  'GET /api/projects/:id/search':
    'Find moments by what was said (Roman or Devanagari, typos allowed).',

  'GET /api/jobs/:id': 'Where a processing job stands (the polling fallback of the live feed).',
  'POST /api/jobs/:id/retry': 'Resume a failed processing job where it stopped.',
}

const tagOf = (url: string): string => {
  if (!url.startsWith('/api')) return 'Health'
  if (url.startsWith('/api/auth')) return 'Auth'
  if (url.startsWith('/api/me')) return 'Account'
  if (url.startsWith('/api/uploads')) return 'Uploads'
  if (url.startsWith('/api/jobs')) return 'Jobs'
  if (url.includes('/timeline') || url.includes('/export/')) return 'Timeline'
  if (url.endsWith('/search')) return 'Search'
  if (/\/(transcript|scenes|highlights|chapters|summary|assets)/.test(url)) return 'Content'
  return 'Projects'
}

/** OpenAPI is generated from the Zod route schemas. Served at /docs outside production only. */
export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Lypcut API',
        version: '0.1.0',
        description:
          'Backend for the Lypcut editor. Browsers sign in with httpOnly cookies; other clients send `X-Auth-Mode: bearer` on login and use the returned token as `Authorization: Bearer`. Errors are `{ error: { code, message, details? } }`.',
      },
      servers: [{ url: '/api' }],
      tags: [
        { name: 'Auth' },
        { name: 'Account' },
        { name: 'Projects' },
        { name: 'Uploads' },
        { name: 'Timeline' },
        { name: 'Content' },
        { name: 'Search' },
        { name: 'Jobs' },
        { name: 'Health' },
      ],
    },
    transform: jsonSchemaTransform,
  })

  // Every route gets a tag and a one-line summary from the table above.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    const method = methods.find((m) => m !== 'HEAD' && m !== 'OPTIONS')
    if (!method || route.url.startsWith('/docs')) return
    route.schema = {
      ...route.schema,
      tags: [tagOf(route.url)],
      summary: ROUTE_SUMMARIES[`${method} ${route.url}`],
    }
  })

  if (app.deps.config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' })
  }
}
