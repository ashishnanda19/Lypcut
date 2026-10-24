import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../../index.html?raw'

/** The theme store reads what index.html put on <html> before first paint, so each test sets that first. */
async function freshStore(attribute: string | null) {
  vi.resetModules()
  if (attribute) document.documentElement.dataset.theme = attribute
  else delete document.documentElement.dataset.theme
  return (await import('./theme')).useTheme
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('the theme', () => {
  it('is light for someone who has never chosen', async () => {
    const useTheme = await freshStore(null)
    expect(useTheme.getState().theme).toBe('light')
    expect((await freshStore('light')).getState().theme).toBe('light')
  })

  it('is dark only when it was chosen', async () => {
    expect((await freshStore('dark')).getState().theme).toBe('dark')
  })

  it('the toggle still switches, and remembers the choice', async () => {
    const useTheme = await freshStore('light')
    useTheme.getState().toggle()
    expect(useTheme.getState().theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('lypcut-theme')).toBe('dark')
    useTheme.getState().toggle()
    expect(useTheme.getState().theme).toBe('light')
    expect(localStorage.getItem('lypcut-theme')).toBe('light')
  })

  it('the page itself starts light', () => {
    expect(indexHtml).toMatch(/<html[^>]*data-theme="light"/)
  })
})
