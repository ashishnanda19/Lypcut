import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BrandKit } from '@/types'

interface BrandState extends BrandKit {
  set: (patch: Partial<BrandKit>) => void
  reset: () => void
}

const DEFAULT: BrandKit = {
  fonts: { heading: 'Inter', body: 'Noto Sans Devanagari' },
  colors: { primary: '#ffa83a', accent: '#5fcdbb', text: '#f4efe6' },
  logoName: null,
}

export const useBrand = create<BrandState>()(
  persist(
    (set) => ({
      ...DEFAULT,
      set: (patch) => set(patch),
      reset: () => set(DEFAULT),
    }),
    { name: 'lypcut-brand', version: 1 },
  ),
)
