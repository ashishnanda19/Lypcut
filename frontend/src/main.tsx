import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/noto-sans-devanagari/400.css'
import '@fontsource/noto-sans-devanagari/500.css'
import '@fontsource/noto-sans-devanagari/600.css'
import '@fontsource/noto-sans-devanagari/700.css'
import '@/styles/index.css'
import { App } from '@/app/App'
import { isReal } from '@/lib/runtime'
import { useAuth } from '@/stores/auth'

/**
 * VITE_API_MODE picks the backend. In "mock" the in-browser mock answers every /api route, and starts before the first
 * render so no request ever reaches a missing handler. In "real" the Lypcut backend answers everything (Style included) and
 * the mock is not loaded at all.
 */
async function boot() {
  if (!isReal) {
    const { startMockApi } = await import('@/mocks/browser')
    await startMockApi()
  }
  // A stored sign-in is only a hint: ask the server whether it still holds before showing anything private.
  await useAuth.getState().hydrate()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
