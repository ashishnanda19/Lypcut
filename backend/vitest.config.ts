import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The shared engine is used from its source in tests, so a change to it needs no rebuild.
const timelineCore = fileURLToPath(
  new URL('../packages/timeline-core/src/index.ts', import.meta.url),
)

export default defineConfig({
  resolve: { alias: { '@lypcut/timeline-core': timelineCore } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/helpers/global-setup.ts'],
          // One shared Postgres, Redis and bucket: files run one at a time so they never trample each other.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
