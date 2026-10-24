import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Chapter,
  Highlight,
  Job,
  Project,
  ReelMetric,
  Scene,
  SearchResult,
  StyleProfile,
  Transcript,
} from '@/types'
import { api } from './client'

export const keys = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  transcript: (id: string) => ['transcript', id] as const,
  scenes: (id: string) => ['scenes', id] as const,
  highlights: (id: string) => ['highlights', id] as const,
  chapters: (id: string) => ['chapters', id] as const,
  search: (id: string, q: string) => ['search', id, q] as const,
  style: ['style'] as const,
  reels: ['reels'] as const,
}

export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: () => api.get<Project[]>('/projects'),
    refetchInterval: (q) =>
      q.state.data?.some((p) => p.status === 'processing' || p.status === 'uploading')
        ? 4000
        : false,
  })

export const useProject = (id: string | undefined) =>
  useQuery({
    queryKey: keys.project(id ?? ''),
    queryFn: () => api.get<Project>(`/projects/${id}`),
    enabled: !!id,
  })

export const useTranscript = (id: string | undefined) =>
  useQuery({
    queryKey: keys.transcript(id ?? ''),
    queryFn: () => api.get<Transcript>(`/projects/${id}/transcript`),
    enabled: !!id,
    staleTime: Infinity,
  })

export const useScenes = (id: string | undefined) =>
  useQuery({
    queryKey: keys.scenes(id ?? ''),
    queryFn: () => api.get<Scene[]>(`/projects/${id}/scenes`),
    enabled: !!id,
    staleTime: Infinity,
  })

export const useHighlights = (id: string | undefined) =>
  useQuery({
    queryKey: keys.highlights(id ?? ''),
    queryFn: () => api.get<Highlight[]>(`/projects/${id}/highlights`),
    enabled: !!id,
    staleTime: Infinity,
  })

export const useChapters = (id: string | undefined) =>
  useQuery({
    queryKey: keys.chapters(id ?? ''),
    queryFn: () => api.get<Chapter[]>(`/projects/${id}/chapters`),
    enabled: !!id,
    staleTime: Infinity,
  })

export const useSearch = (id: string | undefined, q: string) =>
  useQuery({
    queryKey: keys.search(id ?? '', q),
    queryFn: () => api.get<SearchResult[]>(`/projects/${id}/search?q=${encodeURIComponent(q)}`),
    enabled: !!id && q.trim().length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })

export const useStyle = () =>
  useQuery({ queryKey: keys.style, queryFn: () => api.get<StyleProfile>('/style') })
export const useReels = () =>
  useQuery({ queryKey: keys.reels, queryFn: () => api.get<ReelMetric[]>('/style/reels') })

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { title?: string; fileName: string; durationSec?: number }) =>
      api.post<{ project: Project; job: Job }>('/projects', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/projects/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const prev = qc.getQueryData<Project[]>(keys.projects)
      qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== id))
      return { prev }
    },
    onError: (_e, _id, ctx) => ctx?.prev && qc.setQueryData(keys.projects, ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.projects }),
  })
}

export function useRenameProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Project>(`/projects/${id}`, { title }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: keys.projects })
      qc.setQueryData(keys.project(p.id), p)
    },
  })
}

export function useAddSamples() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<Project[]>('/projects/samples'),
    onSuccess: (list) => qc.setQueryData(keys.projects, list),
  })
}

export function useConnectStyle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<StyleProfile>('/style/connect'),
    onSuccess: (p) => {
      qc.setQueryData(keys.style, p)
      qc.invalidateQueries({ queryKey: keys.reels })
    },
  })
}

export function useUploadStyle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (count: number) => api.post<StyleProfile>('/style/upload', { count }),
    onSuccess: (p) => {
      qc.setQueryData(keys.style, p)
      qc.invalidateQueries({ queryKey: keys.reels })
    },
  })
}

export function useDisconnectStyle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.delete<StyleProfile>('/style/connect'),
    onSuccess: (p) => {
      qc.setQueryData(keys.style, p)
      qc.invalidateQueries({ queryKey: keys.reels })
    },
  })
}
