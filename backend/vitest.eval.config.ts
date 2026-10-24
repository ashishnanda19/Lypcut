import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const timelineCore = fileURLToPath(
  new URL('../packages/timeline-core/src/index.ts', import.meta.url),
)

/** The assistant's evaluation (npm run eval). Kept out of `npm test`: it can call a paid model and prints a report. */
export default defineConfig({
  resolve: { alias: { '@lypcut/timeline-core': timelineCore } },
  test: {
    name: 'eval',
    include: ['eval/**/*.eval.ts'],
    environment: 'node',
    globalSetup: ['test/helpers/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
})
