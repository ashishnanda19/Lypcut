import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against the real backend (../backend, `docker compose up`).
 *   npm run e2e:real
 * The app runs with VITE_API_MODE=real and talks to the backend through the dev proxy. The page's origin must be in the
 * backend's CORS_ORIGINS: localhost:5173 is by default; for another port set E2E_PORT and start the backend with
 * CORS_ORIGINS=http://localhost:<port>.
 */
const port = process.env.E2E_PORT ?? '5173'
const origin = `http://localhost:${port}`

export default defineConfig({
  testDir: 'e2e',
  testMatch: /real-.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: origin, trace: 'retain-on-failure', acceptDownloads: true },
  webServer: {
    command: `VITE_API_MODE=real npm run dev -- --host localhost --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
      },
    },
  ],
})
