import { createContext, useContext } from 'react'
import type { Chapter, Highlight, Project, Scene, Transcript } from '@/types'

export interface EditorData {
  project: Project
  transcript: Transcript
  scenes: Scene[]
  highlights: Highlight[]
  chapters: Chapter[]
  videoUrl: string
}

const Ctx = createContext<EditorData | null>(null)
export const EditorDataProvider = Ctx.Provider

export function useEditorData(): EditorData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useEditorData must be used inside the editor')
  return v
}
