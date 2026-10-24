import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Film, Languages, Sparkles, Users } from 'lucide-react'
import { keys, useDeleteProject } from '@/api/hooks'
import { useJob } from '@/api/useJob'
import { LeapLoader } from '@/components/brand/LeapLoader'
import { MetricChip } from '@/components/domain/MetricChip'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Stepper, type StepperStep } from '@/components/ui/Stepper'
import { toast } from '@/components/ui/Toast'
import { timeLeft } from '@/lib/format'
import { formatDuration } from '@/lib/time'
import { AI } from '@/lib/config'
import { isReal } from '@/lib/runtime'
import type { Project } from '@/types'

const STEPS: StepperStep[] = [
  { id: 'up', label: 'Uploaded', description: 'Your video is safe with us.' },
  {
    id: 'split',
    label: 'Splitting into clips',
    description: 'Cutting at scene changes and pauses.',
  },
  { id: 'tr', label: 'Transcribing', description: 'Reading every Hindi and English word.' },
  {
    id: 'idx',
    label: 'Indexing scenes and speakers',
    description: `So ${AI.name} can find any moment.`,
  },
  { id: 'ready', label: 'Ready', description: 'Open the editor and start.' },
]

/** Shown while a project is not ready yet. Live from the job socket, with a polling fallback. */
export function ProcessingView({ project }: { project: Project }) {
  const qc = useQueryClient()
  const { job, retry } = useJob(project.jobId)
  const del = useDeleteProject()
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  const lastDone = useRef(false)

  // A once-a-second clock for the time-left estimate.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // When the job finishes, refresh the project so the page flips to the editor.
  useEffect(() => {
    if (job?.status === 'done' && !lastDone.current) {
      lastDone.current = true
      void qc.invalidateQueries({ queryKey: keys.project(project.id) })
      void qc.invalidateQueries({ queryKey: keys.projects })
      toast({
        title: 'Ready to edit',
        description: `${AI.name} found the moments worth posting.`,
        tone: 'ai',
      })
    }
  }, [job?.status, project.id, qc])

  const failed = job?.status === 'failed' || (!job && project.status === 'failed')
  const progress = job?.progress ?? project.progress ?? 0
  const step = job?.status === 'done' ? STEPS.length : (job?.step ?? 0)
  const elapsed = (now - startedAt) / 1000
  const remaining = progress > 6 ? (elapsed / progress) * (100 - progress) : NaN

  return (
    <div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-[1fr_1.1fr]">
      <div>
        <PlaceholderThumb
          seed={project.thumbSeed}
          className="w-full rounded-card border border-line"
        >
          <span className="tnum absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {formatDuration(project.durationSec)}
          </span>
        </PlaceholderThumb>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{project.title}</h1>
        <div className="mt-4 flex flex-wrap gap-2" aria-live="polite" aria-label="Found so far">
          {job?.found?.scenes != null && (
            <MetricChip
              tone="saffron"
              icon={<Film className="size-3.5" aria-hidden="true" />}
              label="Scenes"
              value={job.found.scenes}
            />
          )}
          {job?.found?.language && (
            <MetricChip
              tone="teal"
              icon={<Languages className="size-3.5" aria-hidden="true" />}
              label="Language"
              value={job.found.language}
            />
          )}
          {job?.found?.speakers != null && (
            <MetricChip
              icon={<Users className="size-3.5" aria-hidden="true" />}
              label="Speakers"
              value={job.found.speakers}
            />
          )}
          {job?.found?.hooks != null && (
            <MetricChip
              tone="saffron"
              icon={<Sparkles className="size-3.5" aria-hidden="true" />}
              label="Hooks"
              value={job.found.hooks}
            />
          )}
        </div>
      </div>

      <section
        aria-labelledby="proc-h"
        className="rounded-panel border border-line bg-surface-1 p-6"
      >
        {failed ? (
          <div role="alert" className="mb-6 rounded-card bg-danger-soft p-4">
            <p className="flex items-center gap-2 font-semibold text-danger-text">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Processing stopped
            </p>
            <p className="mt-1 text-sm text-danger-text/90">
              {job?.error ?? 'Something went wrong while processing this video.'}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => void retry()}>
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={del.isPending}
                onClick={async () => {
                  await del.mutateAsync(project.id)
                  toast({ title: 'Project deleted', tone: 'info' })
                  window.location.assign('/app')
                }}
              >
                Delete project
              </Button>
            </div>
          </div>
        ) : (
          <div className="mb-6 flex items-center gap-3">
            <LeapLoader label="Processing" />
            <div>
              <h2 id="proc-h" className="font-semibold">
                {job?.detail ?? 'Getting started'}
              </h2>
              <p className="tnum text-sm text-muted">
                {Number.isFinite(remaining)
                  ? `About ${timeLeft(remaining)} left`
                  : 'Estimating time'}
              </p>
            </div>
          </div>
        )}
        {failed && (
          <h2 id="proc-h" className="sr-only">
            Processing failed
          </h2>
        )}

        <ProgressBar
          value={progress}
          label="Processing progress"
          tone={failed ? 'saffron' : 'teal'}
          className="mb-6"
        />
        <Stepper steps={STEPS} current={step} failedAt={failed ? (job?.step ?? 2) : undefined} />

        <p className="mt-6 border-t border-line pt-4 text-[13px] text-muted">
          You can leave this page. We keep going and you will find it under{' '}
          <Link to="/app" className="font-medium text-accent hover:underline">
            Projects
          </Link>
          .
        </p>
      </section>
    </div>
  )
}

/**
 * An upload that stopped partway. The file lives in the browser that sent it, so the person chooses it again;
 * against the real backend the same project and the parts already sent are picked up where they stopped.
 */
export function UploadPausedView({ project }: { project: Project }) {
  const del = useDeleteProject()
  return (
    <div className="mx-auto max-w-lg rounded-panel border border-line bg-surface-1 p-8 text-center">
      <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
      <p className="mt-3 text-muted">
        This upload stopped at {project.progress ?? 0}%. Choose the video again to finish it.
      </p>
      <ProgressBar
        value={project.progress ?? 0}
        label="Upload progress"
        size="sm"
        className="mx-auto mt-6 max-w-xs"
      />
      <div className="mt-6 flex justify-center gap-2">
        <Button asChild variant="primary">
          <Link to={isReal ? `/app/new?resume=${project.id}` : '/app/new'}>
            Choose the file again
          </Link>
        </Button>
        <Button
          variant="ghost"
          loading={del.isPending}
          onClick={async () => {
            await del.mutateAsync(project.id)
            window.location.assign('/app')
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  )
}
