import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CircleAlert, FileVideo, Pause, Play, RotateCw, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { DropZone } from '@/features/dashboard/DropZone'
import { fileSize, timeLeft } from '@/lib/format'
import { formatDuration } from '@/lib/time'
import { uid } from '@/lib/ids'
import { isReal } from '@/lib/runtime'
import { useUploadQueue } from '@/stores/uploadQueue'
import { startUpload, type UploadHandle } from './index'

type Phase = 'uploading' | 'paused' | 'creating' | 'done' | 'error'
interface Item {
  id: string
  file: File
  progress: number
  phase: Phase
  /** Rough seconds left, once there is enough data to guess. */
  secondsLeft: number | null
  durationSec?: number
  projectId?: string
  error?: string
  /** False for a file that will never be accepted (too long, not a video): Retry would only repeat the refusal. */
  retryable: boolean
}

const MAX_BYTES = 8 * 1024 ** 3

/** Read the real length of the video in the browser, so the project shows the right duration. */
function readDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    const done = (d?: number) => {
      URL.revokeObjectURL(url)
      resolve(d && Number.isFinite(d) ? d : undefined)
    }
    v.preload = 'metadata'
    v.onloadedmetadata = () => done(v.duration)
    v.onerror = () => done()
    setTimeout(() => done(), 2500)
    v.src = url
  })
}

function makeItem(file: File): Item {
  const tooBig = file.size > MAX_BYTES
  return {
    id: uid('up'),
    file,
    progress: 0,
    phase: tooBig ? 'error' : 'uploading',
    error: tooBig
      ? `This file is ${fileSize(file.size)}. The limit is ${fileSize(MAX_BYTES)}.`
      : undefined,
    secondsLeft: null,
    retryable: !tooBig,
  }
}

export function NewProjectPage() {
  const navigate = useNavigate()
  const take = useUploadQueue((s) => s.take)
  // "Choose the file again" on an unfinished upload comes here with the project to finish.
  const resumeId = useSearchParams()[0].get('resume') ?? undefined
  const [items, setItems] = useState<Item[]>([])
  const started = useRef(false)
  const handles = useRef(new Map<string, UploadHandle>())
  // The project to finish goes to the first file only.
  const resumeLeft = useRef(resumeId)

  const patch = useCallback(
    (id: string, p: Partial<Item>) =>
      setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it))),
    [],
  )

  const begin = useCallback(
    async (it: Item) => {
      const durationSec = await readDuration(it.file)
      if (durationSec) patch(it.id, { durationSec })
      const into = resumeLeft.current
      resumeLeft.current = undefined
      handles.current.set(
        it.id,
        startUpload(
          it.file,
          durationSec,
          {
            progress: (progress, secondsLeft) =>
              patch(it.id, { progress, secondsLeft, phase: 'uploading' }),
            finishing: () => patch(it.id, { phase: 'creating', progress: 100 }),
            done: (projectId) => patch(it.id, { phase: 'done', projectId }),
            failed: (error, retryable) => patch(it.id, { phase: 'error', error, retryable }),
          },
          into,
        ),
      )
    },
    [patch],
  )

  const add = useCallback(
    (files: File[]) => {
      const next = files.map(makeItem)
      setItems((list) => [...list, ...next])
      next.filter((it) => it.phase === 'uploading').forEach((it) => void begin(it))
    },
    [begin],
  )

  // Files chosen on the dashboard are waiting in the queue.
  useEffect(() => {
    if (started.current) return
    started.current = true
    const staged = take()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hand-off from the staging store
    if (staged.length) add(staged)
  }, [take, add])

  // Leaving the page stops the transfer (the file lives in this tab). What already arrived stays with the project,
  // which then offers to finish it.
  useEffect(() => {
    const live = handles.current
    return () => live.forEach((h) => h.pause())
  }, [])

  // One file, finished: go straight to its processing screen.
  useEffect(() => {
    if (items.length === 1 && items[0]!.phase === 'done') {
      const t = setTimeout(() => navigate(`/app/project/${items[0]!.projectId}`), 450)
      return () => clearTimeout(t)
    }
  }, [items, navigate])

  // Warn before closing the tab mid-upload.
  const uploading = items.some(
    (i) => i.phase === 'uploading' || i.phase === 'paused' || i.phase === 'creating',
  )
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])

  const pause = (it: Item) => {
    handles.current.get(it.id)?.pause()
    patch(it.id, { phase: 'paused' })
  }
  const resume = (it: Item) => {
    handles.current.get(it.id)?.resume()
    patch(it.id, { phase: 'uploading' })
  }
  const retry = (it: Item) => {
    patch(it.id, { phase: 'uploading', error: undefined })
    const h = handles.current.get(it.id)
    if (h) h.retry()
    else void begin(it)
  }
  const remove = (it: Item) => {
    handles.current.get(it.id)?.cancel()
    handles.current.delete(it.id)
    setItems((l) => l.filter((x) => x.id !== it.id))
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-[-0.035em] sm:text-4xl">New project</h1>
        <p className="mt-1.5 text-muted">
          {resumeId && isReal
            ? 'Choose the same video again and we will carry on from where it stopped.'
            : 'Add a long video. We split it, transcribe it and find the moments worth posting.'}
        </p>
      </div>

      <DropZone onFiles={add} compact={items.length > 0} />

      {items.length > 0 && (
        <section aria-labelledby="up-h">
          <h2 id="up-h" className="mb-3 text-lg font-semibold">
            {uploading ? 'Uploading' : 'Uploads'}
          </h2>
          <ul className="space-y-3">
            {items.map((it) => {
              return (
                <li
                  key={it.id}
                  className="flex items-center gap-4 rounded-card border border-line bg-surface-1 p-4"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-muted">
                    <FileVideo className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.file.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {fileSize(it.file.size)}
                      {it.durationSec ? ` · ${formatDuration(it.durationSec)}` : ''}
                      {it.phase === 'uploading' && (
                        <span className="tnum">
                          {' '}
                          · {it.progress}%
                          {it.secondsLeft !== null && ` · ${timeLeft(it.secondsLeft)} left`}
                        </span>
                      )}
                      {it.phase === 'paused' && (
                        <span className="tnum"> · Paused at {it.progress}%</span>
                      )}
                      {it.phase === 'creating' && ' · Starting processing'}
                    </p>
                    {(it.phase === 'uploading' ||
                      it.phase === 'paused' ||
                      it.phase === 'creating') && (
                      <ProgressBar
                        value={it.phase === 'creating' ? null : it.progress}
                        size="sm"
                        label={`Uploading ${it.file.name}`}
                        className="mt-2.5"
                      />
                    )}
                    {it.phase === 'error' && (
                      <p
                        role="alert"
                        className="mt-1.5 flex items-start gap-1.5 text-[13px] text-danger-text"
                      >
                        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        {it.error}
                      </p>
                    )}
                  </div>
                  {it.phase === 'uploading' && (
                    <IconButton label={`Pause ${it.file.name}`} size="sm" onClick={() => pause(it)}>
                      <Pause className="size-4" aria-hidden="true" />
                    </IconButton>
                  )}
                  {it.phase === 'paused' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      leading={<Play className="size-4" aria-hidden="true" />}
                      onClick={() => resume(it)}
                    >
                      Resume
                    </Button>
                  )}
                  {it.phase === 'done' && it.projectId && items.length > 1 && (
                    <Button
                      asChild
                      size="sm"
                      variant="secondary"
                      trailing={<ArrowRight className="size-4" aria-hidden="true" />}
                    >
                      <Link to={`/app/project/${it.projectId}`}>Open</Link>
                    </Button>
                  )}
                  {it.phase === 'done' && items.length === 1 && (
                    <Check className="size-5 text-teal-text" aria-label="Uploaded" />
                  )}
                  {it.phase === 'error' && it.retryable && (
                    <Button
                      size="sm"
                      variant="secondary"
                      leading={<RotateCw className="size-4" aria-hidden="true" />}
                      onClick={() => retry(it)}
                    >
                      Retry
                    </Button>
                  )}
                  {it.phase !== 'done' && (
                    <IconButton
                      label={`Remove ${it.file.name}`}
                      size="sm"
                      onClick={() => remove(it)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </IconButton>
                  )}
                </li>
              )
            })}
          </ul>
          {!isReal && (
            <p className="mt-4 text-xs text-faint">
              Preview: the upload is simulated, and your file stays in this browser.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
