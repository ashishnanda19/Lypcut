import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import { jsonSchemaTransform } from 'fastify-type-provider-zod'

/** OpenAPI is generated from the Zod route schemas. Served at /docs outside production only. */
export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Lypcut API',
        version: '0.1.0',
        description: 'Backend for the Lypcut editor.',
      },
      servers: [{ url: '/api' }],
    },
    transform: jsonSchemaTransform,
  })
  if (app.deps.config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' })
  }
}
