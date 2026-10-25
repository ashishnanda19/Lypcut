import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Film, Upload, X } from 'lucide-react'
import { ApiError } from '@/api/client'
import { useSubmitStyleReels } from '@/api/hooks'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { toast } from '@/components/ui/Toast'
import { ACCEPT, pickVideos } from '@/features/dashboard/DropZone'
import { Uploader, type UploadHandle } from '@/features/upload/uploader'
import { fileSize } from '@/lib/format'
import { numbersFor, parseMetricsCsv, type ReelNumbers } from './logic'

/** The most Reels a person can have for style learning (the server enforces it). */
const MAX_REELS = 10
const AT_ONCE = 2

type ItemState = 'ready' | 'queued' | 'uploading' | 'finishing' | 'done' | 'failed'

interface Item {
  id: number
  file: File
  state: ItemState
  percent: number
  reelId?: string
  message?: string
  retryable?: boolean
}

let nextId = 1

/**
 * Pick a few of your past Reels (3 to 5 is plenty), optionally paste their numbers, and Lypcut learns your style from them. The
 * videos go straight to storage in the same resumable way as a project's video; when they have all arrived they are submitted
 * together, and the page follows the learning. The files are deleted as soon as they have been watched: only the numbers and a
 * small picture are kept.
 */
export function UploadReels({
  existing = 0,
  onSubmitted,
  title = 'Upload your best Reels',
  hint = 'Pick 3 to 5 of your Reels, up to 90 seconds each. Your files are deleted as soon as they have been watched: only numbers and a small picture are kept.',
}: {
  /** Reels already uploaded, which count toward the limit of ten. */
  existing?: number
  onSubmitted?: () => void
  title?: string
  hint?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const handles = useRef(new Map<number, UploadHandle>())
  const [items, setItemsState] = useState<Item[]>([])
  // The latest list, for the upload callbacks, which outlive the render that made them.
  const latest = useRef<Item[]>([])
  const setItems = useCallback((fn: (list: Item[]) => Item[]) => {
    latest.current = fn(latest.current)
    setItemsState(latest.current)
  }, [])
  const [csv, setCsv] = useState('')
  const [showNumbers, setShowNumbers] = useState(false)
  const [started, setStarted] = useState(false)
  const submit = useSubmitStyleReels()

  const patch = useCallback(
    (id: number, p: Partial<Item>) =>
      setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i))),
    [setItems],
  )
  const room = MAX_REELS - existing - items.length

  const add = (files: File[]) => {
    if (!files.length) return
    if (files.length > room) {
      toast({
        title: `You can have up to ${MAX_REELS} Reels`,
        description: room > 0 ? `Only the first ${room} were added.` : 'Remove one to add another.',
        tone: 'info',
      })
    }
    setItems((list) => [
      ...list,
      ...files
        .slice(0, Math.max(0, room))
        .map((file) => ({ id: nextId++, file, state: 'ready' as const, percent: 0 })),
    ])
  }

  const remove = (id: number) => {
    handles.current.get(id)?.cancel()
    handles.current.delete(id)
    setItems((list) => list.filter((i) => i.id !== id))
  }

  /** Starts the Reels that are waiting, two at a time. Called when the person says go, and whenever one finishes. */
  function pump() {
    const list = latest.current
    const running = list.filter((i) => i.state === 'uploading' || i.state === 'finishing').length
    for (const item of list
      .filter((i) => i.state === 'queued')
      .slice(0, Math.max(0, AT_ONCE - running))) {
      patch(item.id, { state: 'uploading' })
      const up = new Uploader(
        item.file,
        undefined,
        {
          progress: (percent) => patch(item.id, { state: 'uploading', percent }),
          finishing: () => patch(item.id, { state: 'finishing', percent: 100 }),
          done: (reelId) => {
            patch(item.id, { state: 'done', percent: 100, reelId, message: undefined })
            pump()
          },
          failed: (message, retryable) => {
            patch(item.id, { state: 'failed', message, retryable })
            pump()
          },
        },
        {},
        null,
        { purpose: 'style_reel' },
      )
      handles.current.set(item.id, up)
      up.start()
    }
  }

  const parsed = parseMetricsCsv(csv)
  const matched = numbersFor(
    parsed.rows,
    items.map((i) => i.file.name),
  )
  const busy = items.some(
    (i) => i.state === 'queued' || i.state === 'uploading' || i.state === 'finishing',
  )
  const done = items.filter((i) => i.state === 'done')
  const failed = items.filter((i) => i.state === 'failed')

  const go = () => {
    setStarted(true)
    setItems((list) =>
      list.map((i) => (i.state === 'ready' ? { ...i, state: 'queued' as const } : i)),
    )
    pump()
  }

  // Everything has arrived: learn from it.
  useEffect(() => {
    // Waits while anything is still going, and while a Reel has failed: the person decides whether to retry it or drop it.
    if (!started || busy || failed.length || !done.length || submit.isPending || submit.isSuccess)
      return
    const stem = (n: string) => n.replace(/\.[^./\\]+$/, '').toLowerCase()
    const metrics = matched.used.flatMap((row) => {
      const item = done.find((d) => stem(d.file.name) === stem(row.fileName))
      if (!item?.reelId) return []
      const numbers: Partial<ReelNumbers> = { ...row }
      delete numbers.fileName
      return [{ reelId: item.reelId, ...numbers }]
    })
    submit.mutate(
      { count: done.length, ...(metrics.length ? { metrics } : {}) },
      {
        onSuccess: () => {
          toast({
            title: 'Learning your style',
            description: 'This takes a few minutes. You can leave this page.',
            tone: 'success',
          })
          setItems(() => [])
          setCsv('')
          setStarted(false)
          handles.current.clear()
          onSubmitted?.()
        },
        onError: (e) =>
          toast({
            title: 'Could not start learning',
            description: e instanceof ApiError ? e.message : 'Please try again.',
            tone: 'error',
          }),
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the last upload lands
  }, [started, busy, done.length, failed.length])

  useEffect(() => {
    const live = handles.current
    return () => live.forEach((h) => h.pause())
  }, [])

  const canStart = items.some((i) => i.state === 'ready') && !parsed.errors.length && !started
  const retry = (i: Item) => {
    handles.current.get(i.id)?.retry()
    patch(i.id, { state: 'uploading', message: undefined })
  }

  return (
    <section className="rounded-panel border border-line bg-surface-1 p-6">
      <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-muted">
        <Upload className="size-5" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{hint}</p>

      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        data-testid="reel-input"
        className="sr-only"
        aria-label="Choose Reels"
        onChange={(e) => {
          add(pickVideos(e.target.files))
          e.target.value = ''
        }}
      />

      {items.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Reels to learn from">
          {items.map((i) => (
            <li key={i.id} className="rounded-control border border-line bg-surface-2 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <Film className="size-4 shrink-0 text-faint" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.file.name}</span>
                  <span className="block text-xs text-muted" aria-live="polite">
                    {i.state === 'ready' && fileSize(i.file.size)}
                    {i.state === 'queued' && 'Waiting'}
                    {i.state === 'uploading' && `Uploading ${i.percent}%`}
                    {i.state === 'finishing' && 'Checking the file'}
                    {i.state === 'done' && (
                      <span className="inline-flex items-center gap-1 text-teal-text">
                        <Check className="size-3" aria-hidden="true" /> Uploaded
                      </span>
                    )}
                    {i.state === 'failed' && <span className="text-danger-text">{i.message}</span>}
                  </span>
                </span>
                {i.state === 'failed' && i.retryable && (
                  <Button size="sm" variant="secondary" onClick={() => retry(i)}>
                    Retry
                  </Button>
                )}
                {i.state !== 'finishing' && (
                  <button
                    type="button"
                    aria-label={`Remove ${i.file.name}`}
                    onClick={() => remove(i.id)}
                    className="rounded-full p-1 text-faint hover:text-text"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              {(i.state === 'uploading' || i.state === 'finishing') && (
                <ProgressBar
                  className="mt-2"
                  size="sm"
                  value={i.state === 'finishing' ? null : i.percent}
                  label={`Uploading ${i.file.name}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={started || room <= 0}
          leading={<Film className="size-4" aria-hidden="true" />}
          onClick={() => input.current?.click()}
        >
          {items.length ? 'Add more Reels' : 'Choose Reels'}
        </Button>
        {items.length > 0 && !started && (
          <Button variant="primary" disabled={!canStart} onClick={go}>
            Learn my style
          </Button>
        )}
        {(submit.isPending || busy) && <span className="text-sm text-muted">Working…</span>}
        {failed.length > 0 && !busy && (
          <span role="status" className="text-sm text-muted">
            Retry or remove the Reel that did not upload to carry on.
          </span>
        )}
      </div>
      {existing + items.length > 0 && (
        <p className="mt-2 text-xs text-faint">
          {existing + items.length} of {MAX_REELS} Reels
        </p>
      )}

      {items.length > 0 && !started && (
        <div className="mt-4 border-t border-line pt-3">
          <button
            type="button"
            aria-expanded={showNumbers}
            onClick={() => setShowNumbers((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${showNumbers ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            Add your numbers (optional)
          </button>
          {showNumbers && (
            <div className="mt-2">
              <p className="mb-2 text-xs text-muted">
                Paste from a spreadsheet, one Reel per line: file name, views, likes, comments,
                saves, shares, share watched (0 to 100). A header line is fine. Leave a number blank
                if you do not know it. With numbers, Lypcut learns from your <em>best</em> Reels,
                not all of them.
              </p>
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={5}
                aria-label="Your numbers"
                placeholder={
                  'file,views,likes,comments,saves,shares,watched\nreel-1.mp4,48200,3100,210,980,640,74'
                }
                className="w-full rounded-control border border-line bg-surface-2 p-2.5 font-mono text-xs focus:border-saffron focus:outline-none"
              />
              {parsed.errors.map((e) => (
                <p key={e} role="alert" className="text-xs text-danger-text">
                  {e}
                </p>
              ))}
              {!parsed.errors.length && matched.unmatched.length > 0 && (
                <p className="text-xs text-muted">
                  No file chosen for: {matched.unmatched.join(', ')}.
                </p>
              )}
              {!parsed.errors.length && matched.used.length > 0 && (
                <p className="text-xs text-teal-text">
                  Numbers found for {matched.used.length} of your Reels.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
