import { setupWorker } from 'msw/browser'
import { handlers, styleHandlers } from './handlers'

/**
 * Start the mock backend. Resolves once the service worker is ready, so no request is missed.
 * `all` answers the whole API; `style` answers only /api/style/*, and everything else goes to the real server.
 */
export async function startMockApi(scope: 'all' | 'style' = 'all') {
  const worker = setupWorker(...(scope === 'all' ? handlers : styleHandlers))
  await worker.start({
    onUnhandledFrame: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })
}
