import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, Eye, GitCompare, History, Redo2, RotateCcw, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/format'
import type { Version } from '@/types'
import { canRedo, canUndo, useEditor } from './store'
import { peekOlder, restoreOlder } from './sync'

function Row({
  v,
  state,
  current,
  previewing,
  onPeek,
  onRestore,
}: {
  v: Pick<Version, 'id' | 'label' | 'author' | 'at'>
  state: 'live' | 'undone' | 'branch'
  current: boolean
  previewing: boolean
  onPeek: () => void
  onRestore: () => void
}) {
  return (
    <div className={cn('relative pl-8', state !== 'live' && 'opacity-60')}>
      <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-0 w-0.5 bg-line" />
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-1 top-4 flex size-[15px] items-center justify-center rounded-full border-2',
          current
            ? 'border-saffron bg-saffron'
            : v.author === 'ai'
              ? 'border-saffron/70 bg-surface-1'
              : 'border-line-strong bg-surface-1',
        )}
      />
      <div
        className={cn(
          'mb-2 rounded-card border p-3 transition-colors',
          previewing
            ? 'border-teal bg-teal-soft'
            : current
              ? 'border-saffron/50 bg-saffron-soft'
              : 'border-line bg-surface-1 hover:border-line-strong',
        )}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug">{v.label}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Badge tone={v.author === 'ai' ? 'saffron' : 'neutral'}>
                {v.author === 'ai' ? 'AI' : 'You'}
              </Badge>
              <span className="tnum">{timeAgo(v.at)}</span>
              {current && <span className="font-semibold text-accent">Current</span>}
              {state === 'undone' && <span>Undone</span>}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant={previewing ? 'teal' : 'ghost'}
              aria-pressed={previewing}
              leading={<Eye className="size-3.5" aria-hidden="true" />}
              onClick={onPeek}
            >
              {previewing ? 'Viewing' : 'View'}
            </Button>
            {!current && (
              <Button
                size="sm"
                variant="secondary"
                leading={<RotateCcw className="size-3.5" aria-hidden="true" />}
                onClick={onRestore}
              >
                Restore
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function HistoryPanel() {
  const versions = useEditor((s) => s.versions)
  const cursor = useEditor((s) => s.cursor)
  const archived = useEditor((s) => s.archived)
  const older = useEditor((s) => s.older)
  const preview = useEditor((s) => s.preview)
  const compare = useEditor((s) => s.compare)
  const [showArchive, setShowArchive] = useState(false)
  const [showOlder, setShowOlder] = useState(false)
  const canU = useEditor(canUndo)
  const canR = useEditor(canRedo)
  const store = useEditor.getState
  const list = [...versions].reverse()
  const scroller = useRef<HTMLDivElement>(null)

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is used as documented
  const virt = useVirtualizer({
    count: list.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 86,
    overscan: 10,
  })

  const restore = (id: string) => {
    const res = store().restore(id)
    if (!res.ok) toast({ title: 'Nothing to restore', description: res.error, tone: 'info' })
    else
      toast({
        title: 'Restored',
        description: 'Your later versions are still here.',
        tone: 'success',
      })
  }
  const peek = (id: string) =>
    store().peekVersion(preview?.kind === 'version' && preview.id === id ? null : id)
  const peekSaved = async (n: number) => {
    if (preview?.kind === 'version' && preview.id === `v_${n}`) return store().peekVersion(null)
    try {
      await peekOlder(n)
    } catch {
      toast({
        title: 'Could not open that version',
        description: 'Please try again.',
        tone: 'error',
      })
    }
  }
  const restoreSaved = async (n: number) => {
    const res = await restoreOlder(n)
    if (res.ok)
      toast({
        title: 'Restored',
        description: 'Your later versions are still here.',
        tone: 'success',
      })
    else toast({ title: 'Could not restore', description: res.error, tone: 'error' })
  }

  // Edits saved before this session, or on other branches: fetched from the server when viewed or restored.
  const olderBlock = older.length > 0 && (
    <div className="mt-2 border-t border-line pt-3">
      <button
        type="button"
        aria-expanded={showOlder}
        onClick={() => setShowOlder(!showOlder)}
        className="flex w-full items-center gap-2 text-sm font-medium text-muted hover:text-text"
      >
        <History className="size-4" aria-hidden="true" />
        Earlier saved edits ({older.length})
        <ChevronDown
          className={cn('ml-auto size-4 transition-transform', showOlder && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {showOlder && (
        <ul className="mt-3">
          {older.map((o) => (
            <li key={o.n}>
              <Row
                v={{ id: `v_${o.n}`, label: o.label, author: o.author, at: o.at }}
                state="branch"
                current={false}
                previewing={preview?.kind === 'version' && preview.id === `v_${o.n}`}
                onPeek={() => void peekSaved(o.n)}
                onRestore={() => void restoreSaved(o.n)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canU}
          leading={<Undo2 className="size-3.5" aria-hidden="true" />}
          onClick={() => store().undo()}
        >
          Undo
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canR}
          leading={<Redo2 className="size-3.5" aria-hidden="true" />}
          onClick={() => store().redo()}
        >
          Redo
        </Button>
        <span className="tnum ml-auto text-xs text-faint">
          {versions.length - 1} change{versions.length === 2 ? '' : 's'}
        </span>
      </div>
      <Switch
        className="mb-3 rounded-card border border-line bg-surface-2 px-3.5 py-2.5"
        label="Compare with my edit"
        hint="Mark what a viewed version added or changed on the timeline"
        checked={compare}
        onCheckedChange={(v) => store().setCompare(v)}
      />

      {versions.length === 1 ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            size="sm"
            title="Every change lands here"
            description="Each edit, yours or the AI's, becomes a version. Undo any of them, or go back to how it looked before."
          />
          {olderBlock}
        </div>
      ) : (
        <div
          ref={scroller}
          className="scroll-thin min-h-0 flex-1 overflow-y-auto"
          aria-label="Versions, newest first"
        >
          <ol style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const idx = versions.length - 1 - vi.index
              const v = list[vi.index]!
              return (
                <li
                  key={v.id}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <Row
                    v={v}
                    state={idx > cursor ? 'undone' : 'live'}
                    current={idx === cursor}
                    previewing={preview?.kind === 'version' && preview.id === v.id}
                    onPeek={() => peek(v.id)}
                    onRestore={() => restore(v.id)}
                  />
                </li>
              )
            })}
          </ol>
          {archived.length > 0 && (
            <div className="mt-2 border-t border-line pt-3">
              <button
                type="button"
                aria-expanded={showArchive}
                onClick={() => setShowArchive(!showArchive)}
                className="flex w-full items-center gap-2 text-sm font-medium text-muted hover:text-text"
              >
                <History className="size-4" aria-hidden="true" />
                Earlier branches ({archived.length})
                <ChevronDown
                  className={cn('ml-auto size-4 transition-transform', showArchive && 'rotate-180')}
                  aria-hidden="true"
                />
              </button>
              {showArchive && (
                <ul className="mt-3">
                  {[...archived].reverse().map((v) => (
                    <li key={v.id}>
                      <Row
                        v={v}
                        state="branch"
                        current={false}
                        previewing={preview?.kind === 'version' && preview.id === v.id}
                        onPeek={() => peek(v.id)}
                        onRestore={() => restore(v.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {olderBlock}
        </div>
      )}
      {preview?.kind === 'version' && (
        <p className="mt-2 flex items-center gap-2 rounded-full bg-teal-soft px-3 py-1.5 text-xs text-teal-text">
          <GitCompare className="size-3.5" aria-hidden="true" /> Viewing an older version. Your edit
          is unchanged.
          <button
            type="button"
            className="ml-auto font-semibold underline"
            onClick={() => store().peekVersion(null)}
          >
            Back
          </button>
        </p>
      )}
    </div>
  )
}
