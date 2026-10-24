import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useAddSamples, useDeleteProject, useProjects, useRenameProject } from '@/api/hooks'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { AI } from '@/lib/config'
import { greeting, useAuth } from '@/stores/auth'
import { isReal } from '@/lib/runtime'
import { useUploadQueue } from '@/stores/uploadQueue'
import type { Project, ProjectStatus } from '@/types'
import { DropZone } from './DropZone'
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard'

type Filter = 'all' | ProjectStatus

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'processing', label: 'Processing' },
  { id: 'exported', label: 'Exported' },
  { id: 'failed', label: 'Needs retry' },
]

/** One clear next step, picked from the user's own projects. */
function suggestNext(list: Project[]): { text: string; cta: string; to: string } | null {
  const failed = list.find((p) => p.status === 'failed')
  const ready = list.find((p) => p.status === 'ready' && (p.hooksFound ?? 0) > 0)
  if (ready) {
    return {
      text: `${AI.name} found ${ready.hooksFound} hooks in "${ready.title}". Turn the best ones into Reels.`,
      cta: 'Open project',
      to: `/app/project/${ready.id}`,
    }
  }
  if (failed)
    return {
      text: `"${failed.title}" stopped while processing. Retry it in one click.`,
      cta: 'Retry',
      to: `/app/project/${failed.id}`,
    }
  const running = list.find((p) => p.status === 'processing')
  if (running)
    return {
      text: `"${running.title}" is being processed. You can watch it finish.`,
      cta: 'See progress',
      to: `/app/project/${running.id}`,
    }
  return null
}

function RenameDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const rename = useRenameProject()
  const [title, setTitle] = useState(project?.title ?? '')
  const save = async () => {
    const t = title.trim()
    if (!project || !t) return
    await rename.mutateAsync({ id: project.id, title: t })
    toast({ title: 'Renamed', tone: 'success' })
    onClose()
  }
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Rename project" size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input
            label="Project name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={rename.isPending}
              disabled={!title.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const del = useDeleteProject()
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Delete this project?"
        description="The video, transcript and all versions will be removed. This cannot be undone."
        size="sm"
      >
        <p className="rounded-control bg-surface-2 px-3.5 py-2.5 text-sm font-medium">
          {project?.title}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={async () => {
              if (!project) return
              await del.mutateAsync(project.id)
              toast({ title: 'Project deleted', tone: 'info' })
              onClose()
            }}
          >
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DashboardPage() {
  const user = useAuth((s) => s.user)
  const navigate = useNavigate()
  const stage = useUploadQueue((s) => s.stage)
  const { data, isPending, isError, refetch, isFetching } = useProjects()
  const samples = useAddSamples()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [renaming, setRenaming] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)

  const onFiles = (files: File[]) => {
    stage(files)
    navigate('/app/new')
  }

  const list = useMemo(() => data ?? [], [data])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return list.filter(
      (p) =>
        (filter === 'all' ||
          p.status === filter ||
          (filter === 'processing' && p.status === 'uploading')) &&
        (!needle || p.title.toLowerCase().includes(needle)),
    )
  }, [list, q, filter])
  const next = useMemo(() => suggestNext(list), [list])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length }
    for (const p of list) {
      const k = p.status === 'uploading' ? 'processing' : p.status
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [list])

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-[-0.035em] sm:text-4xl">{greeting(user)}</h1>
          <p className="mt-1.5 text-muted">
            Upload a long video and get your best moments back as Reels.
          </p>
        </div>
        <Button
          variant="secondary"
          className="sm:hidden"
          leading={<Plus className="size-4" aria-hidden="true" />}
          onClick={() => navigate('/app/new')}
        >
          New project
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <DropZone onFiles={onFiles} compact />
        <section
          aria-labelledby="next-h"
          className="flex flex-col justify-between gap-5 rounded-panel border border-line bg-surface-1 p-6"
        >
          <div>
            <p id="next-h" className="flex items-center gap-2 text-sm font-semibold text-accent">
              <Sparkles className="size-4" aria-hidden="true" />
              Suggested next
            </p>
            {isPending ? (
              <div className="mt-3 space-y-2" aria-hidden="true">
                <div className="skeleton h-5 w-full rounded-md" />
                <div className="skeleton h-5 w-3/4 rounded-md" />
              </div>
            ) : next ? (
              <p className="mt-3 text-lg font-medium leading-snug">{next.text}</p>
            ) : (
              <p className="mt-3 text-lg font-medium leading-snug">
                Upload your first video and {AI.name} will find the moments worth posting.
              </p>
            )}
          </div>
          {next && (
            <Button
              asChild
              variant="secondary"
              trailing={<ArrowRight className="size-4" aria-hidden="true" />}
              className="self-start"
            >
              <Link to={next.to}>{next.cta}</Link>
            </Button>
          )}
        </section>
      </div>

      <section aria-labelledby="proj-h">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="proj-h" className="mr-auto text-xl font-semibold tracking-tight">
            Your projects
          </h2>
          <Input
            label="Search projects"
            hideLabel
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects"
            className="w-full sm:w-64"
            leading={<Search className="size-4" aria-hidden="true" />}
            trailing={
              q ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQ('')}
                  className="rounded-full p-0.5 hover:text-text"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : undefined
            }
          />
        </div>
        <div
          role="group"
          aria-label="Filter by status"
          className="scroll-thin mb-5 flex gap-2 overflow-x-auto pb-1"
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
                filter === f.id
                  ? 'border-saffron bg-saffron-soft text-accent'
                  : 'border-line text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {f.label}
              {data && <span className="tnum text-xs opacity-80">{counts[f.id] ?? 0}</span>}
            </button>
          ))}
        </div>

        {isError ? (
          <EmptyState
            title="Could not load your projects"
            description="Check your connection and try again."
            action={
              <Button
                variant="primary"
                loading={isFetching}
                leading={<RefreshCw className="size-4" aria-hidden="true" />}
                onClick={() => void refetch()}
              >
                Try again
              </Button>
            }
          />
        ) : isPending ? (
          <ul
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-busy="true"
            aria-label="Loading projects"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </ul>
        ) : list.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description={
              isReal
                ? 'Upload a long video above. We transcribe it and find the moments worth posting.'
                : 'Upload a long video above, or look around with a few sample projects first.'
            }
            action={
              isReal ? undefined : (
                <Button
                  variant="secondary"
                  loading={samples.isPending}
                  onClick={() => samples.mutate()}
                >
                  Add sample projects
                </Button>
              )
            }
          />
        ) : shown.length === 0 ? (
          <EmptyState
            size="sm"
            title="Nothing matches"
            description="Try a different word or clear the filter."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQ('')
                  setFilter('all')
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((p) => (
              <ProjectCard key={p.id} project={p} onRename={setRenaming} onDelete={setDeleting} />
            ))}
          </ul>
        )}
      </section>

      {renaming && (
        <RenameDialog key={renaming.id} project={renaming} onClose={() => setRenaming(null)} />
      )}
      <DeleteDialog project={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}
