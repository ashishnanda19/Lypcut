import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { idParam } from '../projects/schema.js'
import { SearchService } from './service.js'

const hitSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  relevance: z.number(),
  matched: z.array(z.number()),
  from: z.number(),
  to: z.number(),
  thumbSeed: z.string(),
})

const searchQuery = z.object({
  q: z.string().max(200, 'That search is too long.').default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

/**
 *   GET /projects/:id/search?q=funding&limit=8
 * Finds moments in the transcript. A query can be Roman, Devanagari or a whole sentence ("where I talk about funding"),
 * and misspellings are fine. Results are the front end's SearchResult.
 */
export const searchRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new SearchService(app.deps, app.log)
  app.get(
    '/projects/:id/search',
    {
      onRequest: app.authenticate,
      schema: { params: idParam, querystring: searchQuery, response: { 200: z.array(hitSchema) } },
    },
    async (req) => {
      // The editor only searches from two characters; anything shorter is nothing to look for.
      if (req.query.q.trim().length < 2) return []
      return service.search(req.user!.id, req.params.id, req.query.q, req.query.limit)
    },
  )
}
