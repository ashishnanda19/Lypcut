import type { Config } from '../../lib/config.js'
import type { InstagramClient } from './client.js'
import { FakeInstagramClient } from './fake.js'
import { RealInstagramClient } from './real.js'

export * from './client.js'
export { FakeInstagramClient, FAKE_ACCOUNTS } from './fake.js'
export { RealInstagramClient } from './real.js'

/**
 * Picks the Instagram client from the environment. `real` (or `auto` with the three settings present) talks to Meta. `auto`
 * with nothing set uses the stand-in outside production, so the product runs with no Meta app, and nothing in production, where
 * Instagram is then simply not offered (manual upload still works).
 */
export function createInstagramClient(
  config: Pick<
    Config,
    | 'INSTAGRAM_CLIENT'
    | 'INSTAGRAM_APP_ID'
    | 'INSTAGRAM_APP_SECRET'
    | 'INSTAGRAM_REDIRECT_URI'
    | 'INSTAGRAM_API_VERSION'
    | 'NODE_ENV'
  >,
): InstagramClient | null {
  const configured = !!(
    config.INSTAGRAM_APP_ID &&
    config.INSTAGRAM_APP_SECRET &&
    config.INSTAGRAM_REDIRECT_URI
  )
  const real = () =>
    new RealInstagramClient({
      appId: config.INSTAGRAM_APP_ID!,
      appSecret: config.INSTAGRAM_APP_SECRET!,
      redirectUri: config.INSTAGRAM_REDIRECT_URI!,
      apiVersion: config.INSTAGRAM_API_VERSION,
    })
  switch (config.INSTAGRAM_CLIENT) {
    case 'real':
      return real()
    case 'fake':
      return new FakeInstagramClient()
    case 'auto':
      if (configured) return real()
      return config.NODE_ENV === 'production' ? null : new FakeInstagramClient()
  }
}
