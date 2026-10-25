import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/lib/cn'
import type { StyleStatus } from '@/types'
import type { Notice, StatusView } from './logic'

/** What happened when Instagram sent the person back, or what is going on now. The last good profile stays on the page below it. */
export function StatusBanner({
  view,
  failed = [],
  action,
}: {
  view: StatusView
  failed?: StyleStatus['failed']
  /** A button for the states that have a next step: Reconnect, Try again. */
  action?: { label: string; onClick: () => void; loading?: boolean }
}) {
  if (view.kind === 'none' && !failed.length) return null
  const working = view.kind === 'working'
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mb-5 rounded-panel border p-4',
        view.kind === 'reconnect' || view.kind === 'problem'
          ? 'border-danger/40 bg-danger-soft'
          : 'border-line bg-surface-1',
      )}
    >
      {view.kind !== 'none' && (
        <div className="flex flex-wrap items-start gap-3">
          <span className="mt-0.5 text-muted">
            {working ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : view.kind === 'needs_files' ? (
              <Info className="size-4" aria-hidden="true" />
            ) : (
              <AlertTriangle className="size-4" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{view.title}</p>
            <p className="mt-0.5 text-[13px] text-muted">{view.body}</p>
            {working && (
              <ProgressBar className="mt-3" tone="teal" value={view.progress} label={view.title} />
            )}
          </div>
          {action && (
            <Button
              size="sm"
              variant={view.kind === 'reconnect' ? 'primary' : 'secondary'}
              loading={action.loading}
              leading={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          )}
        </div>
      )}
      {failed.length > 0 && (
        <ul className={cn('text-[13px]', view.kind !== 'none' && 'mt-3 border-t border-line pt-3')}>
          {failed.map((f) => (
            <li key={f.id} className="text-muted">
              <span className="font-medium text-text">{f.label}</span>: {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The message Instagram's return leaves on the Style page (for example for a personal account). */
export function NoticeCard({
  notice,
  onDismiss,
  children,
}: {
  notice: Notice
  onDismiss: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'mb-5 rounded-panel border p-5',
        notice.tone === 'error'
          ? 'border-danger/40 bg-danger-soft'
          : notice.tone === 'success'
            ? 'border-teal/40 bg-teal-soft'
            : 'border-saffron/40 bg-saffron-soft',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold">{notice.title}</p>
          <p className="mt-1 max-w-2xl text-sm text-muted">{notice.body}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {children}
    </div>
  )
}
