import { create } from 'zustand'

/**
 * Files picked or dropped on the dashboard wait here while we navigate to the upload screen.
 * (File objects cannot go through the URL or localStorage.)
 */
interface QueueState {
  pending: File[]
  stage: (files: File[]) => void
  take: () => File[]
}

export const useUploadQueue = create<QueueState>((set, get) => ({
  pending: [],
  stage: (files) => set({ pending: files }),
  take: () => {
    const files = get().pending
    set({ pending: [] })
    return files
  },
}))
