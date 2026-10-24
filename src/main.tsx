import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/noto-sans-devanagari/400.css'
import '@fontsource/noto-sans-devanagari/500.css'
import '@fontsource/noto-sans-devanagari/600.css'
import '@fontsource/noto-sans-devanagari/700.css'
import '@/styles/index.css'
import { App } from '@/app/App'

/**
 * The mock API answers /api/* in the browser. Start it before the first render so no request
 * ever reaches a missing server. Set VITE_MOCK=off to skip it when a real backend exists.
 */
async function boot() {
  if (import.meta.env.VITE_MOCK !== 'off') {
    const { startMockApi } = await import('@/mocks/browser')
    await startMockApi()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
