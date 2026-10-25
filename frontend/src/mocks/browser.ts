import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/**
 * Start the mock backend (mock mode only: with the real backend the mock is not loaded). Resolves once the service
 * worker is ready, so no request is missed.
 */
export async function startMockApi() {
  const worker = setupWorker(...handlers)
  await worker.start({
    onUnhandledFrame: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })
}
