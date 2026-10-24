import { create } from 'zustand'

export type Theme = 'dark' | 'light'
const KEY = 'lypcut-theme'

/** Light unless the person has chosen dark (index.html sets the attribute before first paint). */
function readInitial(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* storage can be blocked; the theme still applies for this session */
  }
}

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: readInitial(),
  setTheme: (theme) => {
    apply(theme)
    set({ theme })
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}))
