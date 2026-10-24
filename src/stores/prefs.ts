import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface PrefsState {
  /** Advanced mode reveals more tracks, fine trim handles and effect controls. */
  advanced: boolean
  /** Show the transcript in Devanagari instead of Roman. */
  devanagari: boolean
  /** "Apply my style" in the editor chat. */
  applyStyle: boolean
  snap: boolean
  /** Captions in Devanagari instead of Roman. */
  captionDev: boolean
  /** Remember the last editor tab so people land where they left off. */
  tab: string
  setAdvanced: (v: boolean) => void
  setDevanagari: (v: boolean) => void
  setApplyStyle: (v: boolean) => void
  setSnap: (v: boolean) => void
  setCaptionDev: (v: boolean) => void
  setTab: (v: string) => void
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      advanced: false,
      devanagari: false,
      applyStyle: false,
      snap: true,
      captionDev: false,
      tab: 'chat',
      setAdvanced: (advanced) => set({ advanced }),
      setDevanagari: (devanagari) => set({ devanagari }),
      setApplyStyle: (applyStyle) => set({ applyStyle }),
      setSnap: (snap) => set({ snap }),
      setCaptionDev: (captionDev) => set({ captionDev }),
      setTab: (tab) => set({ tab }),
    }),
    { name: 'lypcut-prefs', version: 1 },
  ),
)
