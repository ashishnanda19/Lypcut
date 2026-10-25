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
  StyleStatus,
  InstagramStart,
  Transcript,
} from '@/types'
import { isReal } from '@/lib/runtime'
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
  styleStatus: ['style', 'status'] as const,
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

/** States in which something is still going on, so the page keeps asking. */
const ACTIVE = new Set(['analysing', 'syncing'])

/**
 * Where style learning is (real backend only: the mock answers straight away). Asks every couple of seconds while Reels are being
 * learned from or Instagram is being read, and not otherwise.
 */
export const useStyleStatus = () =>
  useQuery({
    queryKey: keys.styleStatus,
    queryFn: () => api.get<StyleStatus>('/style/status'),
    enabled: isReal,
    refetchInterval: (q) => (ACTIVE.has(q.state.data?.state ?? '') ? 2000 : false),
  })

/** Asks the server where to send the person to connect Instagram, and what to tell them first. */
export const useStartInstagram = () =>
  useMutation({ mutationFn: () => api.post<InstagramStart>('/style/connect') })

export function useSyncStyle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ jobId: string }>('/style/sync'),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.styleStatus }),
  })
}

/** Learn from the Reels that have finished uploading, with their numbers if the person gave any. */
export function useSubmitStyleReels() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { count: number; metrics?: object[] }) =>
      api.post<StyleProfile>('/style/upload', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.styleStatus })
    },
  })
}

export function useRemoveReel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/style/reels/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.style })
      void qc.invalidateQueries({ queryKey: keys.reels })
      void qc.invalidateQueries({ queryKey: keys.styleStatus })
    },
  })
}

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
      qc.invalidateQueries({ queryKey: keys.styleStatus })
    },
  })
}
