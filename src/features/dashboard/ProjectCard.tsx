import { memo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, MoreHorizontal, Pencil, Sparkles, Trash2, FolderOpen } from 'lucide-react'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import { timeAgo } from '@/lib/format'
import { formatDuration } from '@/lib/time'
import type { Project } from '@/types'

interface Props {
  project: Project
  onRename: (p: Project) => void
  onDelete: (p: Project) => void
}

const busy = (p: Project) => p.status === 'uploading' || p.status === 'processing'

export const ProjectCard = memo(function ProjectCard({ project: p, onRename, onDelete }: Props) {
  const href = `/app/project/${p.id}`
  const navigate = useNavigate()
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-card border border-line bg-surface-1 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong">
      <Link
        to={href}
        className="block rounded-card outline-offset-[-2px]"
        aria-label={`Open ${p.title}`}
      >
        <PlaceholderThumb seed={p.thumbSeed} className="w-full">
          <span className="tnum absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {formatDuration(p.durationSec)}
          </span>
          {busy(p) && p.progress != null && (
            <div className="absolute inset-x-0 bottom-0 px-3 pb-2">
              <ProgressBar value={p.progress} size="sm" label={`${p.title} ${p.status}`} />
            </div>
          )}
        </PlaceholderThumb>
      </Link>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start gap-2">
          <h3 className="line-clamp-2 min-h-[2.5rem] flex-1 text-[15px] font-semibold leading-5">
            <Link
              to={href}
              className="after:absolute after:inset-0 after:content-['']"
              tabIndex={-1}
              aria-hidden="true"
            >
              {p.title}
            </Link>
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for ${p.title}`}
                className="relative z-10 -mr-1.5 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-3 hover:text-text"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                icon={<FolderOpen className="size-4" />}
                onSelect={() => navigate(href)}
              >
                Open
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Pencil className="size-4" />} onSelect={() => onRename(p)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                icon={<Trash2 className="size-4" />}
                onSelect={() => onDelete(p)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          <StatusBadge status={p.status} />
          {p.status === 'ready' && p.hooksFound ? (
            <Badge tone="saffron">
              <Sparkles className="size-3" aria-hidden="true" />
              {p.hooksFound} hooks found
            </Badge>
          ) : null}
          {busy(p) && p.progress != null && <span className="tnum">{p.progress}%</span>}
          <span className="ml-auto flex items-center gap-1">
            <Clock className="size-3" aria-hidden="true" />
            {timeAgo(p.updatedAt)}
          </span>
        </div>
      </div>
    </li>
  )
})

/** Same size as the real card so the grid never jumps when data arrives. */
export function ProjectCardSkeleton() {
  return (
    <li className="overflow-hidden rounded-card border border-line bg-surface-1" aria-hidden="true">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-5 w-2/5" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="ml-auto h-6 w-16 rounded-full" />
        </div>
      </div>
    </li>
  )
}
