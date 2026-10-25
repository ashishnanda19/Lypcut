import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Check,
  Eye,
  Heart,
  Link2,
  Lock,
  Palette,
  Share2,
  Bookmark,
  Unlink,
  Upload,
  X,
} from 'lucide-react'
import {
  keys,
  useConnectStyle,
  useDisconnectStyle,
  useReels,
  useRemoveReel,
  useStartInstagram,
  useStyle,
  useStyleStatus,
  useSyncStyle,
  useUploadStyle,
} from '@/api/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { isReal } from '@/lib/runtime'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { toast } from '@/components/ui/Toast'
import { AI } from '@/lib/config'
import { compactNumber, timeAgo } from '@/lib/format'
import { formatDuration } from '@/lib/time'
import { useBrand } from '@/stores/brand'
import type { InstagramStart, ReelMetric, StyleProfile } from '@/types'
import { connectNotice, describeStatus, maybe, styleName, type Notice } from './logic'
import { NoticeCard, StatusBanner } from './StatusBanner'
import { UploadReels } from './UploadReels'

function Card({
  title,
  children,
  className = '',
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-panel border border-line bg-surface-1 p-5 ${className}`}>
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Bars({ rows, label }: { rows: { label: string; share: number }[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between text-[13px]">
            <span>{r.label}</span>
            <span className="tnum text-muted">{Math.round(r.share * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="presentation">
            <div
              className="h-full rounded-full bg-saffron"
              style={{ width: `${Math.max(2, r.share * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-card bg-surface-2 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="tnum mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-faint">{note}</p>
    </div>
  )
}

/** What will happen, in the server's words, shown before the person is sent to Instagram to approve. */
function ConsentStep({
  consent,
  onContinue,
  onCancel,
}: {
  consent: InstagramStart['consent']
  onContinue: () => void
  onCancel: () => void
}) {
  return (
    <div className="mt-5" role="group" aria-label="Before you connect">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-teal-text">
        <Check className="size-3.5" aria-hidden="true" /> What we read
      </p>
      <ul className="space-y-1.5 text-[13px] text-muted">
        {consent.reads.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] text-muted">{consent.uses}</p>
      <p className="mb-2 mt-4 flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
        <Lock className="size-3.5" aria-hidden="true" /> What we never do
      </p>
      <ul className="space-y-1.5 text-[13px] text-muted">
        {consent.never.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-faint">{consent.disconnect}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="primary" size="lg" onClick={onContinue}>
          Continue to Instagram
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function ConnectCard() {
  const connect = useConnectStyle()
  const upload = useUploadStyle()
  const start = useStartInstagram()
  const [count, setCount] = useState('5')
  const [consent, setConsent] = useState<InstagramStart | null>(null)
  const busy = connect.isPending || upload.isPending || start.isPending

  const connectInstagram = () => {
    if (isReal) {
      // The server says what will happen, then the person goes to Instagram to approve it there.
      start.mutate(undefined, {
        onSuccess: setConsent,
        onError: (e) =>
          toast({
            title: 'Could not connect',
            description:
              e instanceof ApiError && e.status === 501
                ? 'Instagram is not set up here. You can upload your Reels instead.'
                : 'Please try again.',
            tone: 'error',
          }),
      })
      return
    }
    connect.mutate(undefined, {
      onSuccess: () =>
        toast({
          title: 'Instagram connected',
          description: `${AI.name} read your Reels.`,
          tone: 'success',
        }),
      onError: () =>
        toast({ title: 'Could not connect', description: 'Please try again.', tone: 'error' }),
    })
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
      <section className="rounded-panel border border-line bg-surface-1 p-6">
        <span className="grid size-11 place-items-center rounded-full bg-saffron-soft text-accent">
          <Link2 className="size-5" aria-hidden="true" />
        </span>
        <h2 className="mt-4 text-xl font-semibold">Teach {AI.name} your style</h2>
        <p className="mt-1 text-sm text-muted">
          {isReal
            ? `Connect Instagram so ${AI.name} knows which of your Reels did best. Then add those Reels' videos and it learns how you cut: how fast, how long your hooks are, which captions you use. Then “Apply my style” does it for you.`
            : `Connect Instagram and ${AI.name} learns how you cut: how fast, how long your hooks are, which captions you use. Then “Apply my style” does it for you.`}
        </p>
        {consent ? (
          <ConsentStep
            consent={consent.consent}
            onContinue={() => window.location.assign(consent.authUrl)}
            onCancel={() => setConsent(null)}
          />
        ) : (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-teal-text">
                  <Check className="size-3.5" aria-hidden="true" /> What we read
                </p>
                <ul className="space-y-1.5 text-[13px] text-muted">
                  <li>Your Reels and when you posted them</li>
                  <li>Views, likes, saves, shares, watch time</li>
                  <li>Which of your Reels did best</li>
                </ul>
              </div>
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
                  <Lock className="size-3.5" aria-hidden="true" /> What we never touch
                </p>
                <ul className="space-y-1.5 text-[13px] text-muted">
                  <li>Your password or private messages</li>
                  <li>Your followers or comments</li>
                  <li>We never post for you</li>
                </ul>
              </div>
            </div>
            <Button
              className="mt-6"
              variant="primary"
              size="lg"
              loading={connect.isPending || start.isPending}
              disabled={busy}
              onClick={connectInstagram}
            >
              Connect Instagram
            </Button>
            {isReal ? (
              <p className="mt-3 text-xs text-faint">
                Works with Creator and Business accounts (switching is free). Not on one? Upload
                Reels instead.
              </p>
            ) : (
              <p className="mt-3 text-xs text-faint">
                Demo build: this is a simulated connection, no real Instagram sign-in happens.
              </p>
            )}
          </>
        )}
      </section>

      {isReal ? (
        <UploadReels title="No Instagram? Upload Reels instead" />
      ) : (
        <section className="rounded-panel border border-line bg-surface-1 p-6">
          <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-muted">
            <Upload className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold">No Instagram? Upload Reels instead</h2>
          <p className="mt-1 text-sm text-muted">
            Pick a few of your best Reels and {AI.name} learns from the files.
          </p>
          <div className="mt-5 max-w-56">
            <Select
              value={count}
              onValueChange={setCount}
              label="How many Reels"
              options={['3', '5', '8'].map((n) => ({ value: n, label: `${n} Reels` }))}
            />
          </div>
          <Button
            className="mt-4"
            loading={upload.isPending}
            disabled={busy}
            leading={<Upload className="size-4" aria-hidden="true" />}
            onClick={() =>
              upload.mutate(Number(count), {
                onSuccess: () =>
                  toast({
                    title: 'Style learned',
                    description: `From ${count} sample Reels (demo).`,
                    tone: 'success',
                  }),
              })
            }
          >
            Upload Reels
          </Button>
        </section>
      )}
    </div>
  )
}

function ReelCard({ r }: { r: ReelMetric }) {
  const remove = useRemoveReel()
  const number = (n: number | null | undefined) => maybe(n, compactNumber)
  return (
    <li className="overflow-hidden rounded-card border border-line bg-surface-1">
      {r.thumbUrl ? (
        <div className="relative aspect-[9/16] w-full overflow-hidden bg-surface-3">
          <img src={r.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
          {r.durationSec > 0 && (
            <span className="tnum absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
              {formatDuration(r.durationSec)}
            </span>
          )}
        </div>
      ) : (
        <PlaceholderThumb seed={r.thumbSeed} aspect="reel" className="w-full">
          {r.durationSec > 0 && (
            <span className="tnum absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
              {formatDuration(r.durationSec)}
            </span>
          )}
        </PlaceholderThumb>
      )}
      <div className="p-3">
        <div className="flex items-start justify-between gap-1">
          <p className="line-clamp-2 text-[13px] font-medium">{r.title}</p>
          {isReal && r.source === 'upload' && (
            <button
              type="button"
              aria-label={`Remove ${r.title}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(r.id)}
              className="-mr-1 shrink-0 rounded-full p-1 text-faint hover:text-text"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-0.5 text-xs text-faint">{timeAgo(r.postedAt)}</p>
        <dl className="tnum mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted">
          <div className="flex items-center gap-1">
            <Eye className="size-3" aria-hidden="true" />
            <dt className="sr-only">Views</dt>
            <dd>{number(r.views)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Heart className="size-3" aria-hidden="true" />
            <dt className="sr-only">Likes</dt>
            <dd>{number(r.likes)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Bookmark className="size-3" aria-hidden="true" />
            <dt className="sr-only">Saves</dt>
            <dd>{number(r.saves)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Share2 className="size-3" aria-hidden="true" />
            <dt className="sr-only">Shares</dt>
            <dd>{number(r.shares)}</dd>
          </div>
        </dl>
        {r.avgWatchPct != null ? (
          <p className="mt-2 text-xs text-teal-text">
            <span className="tnum font-semibold">{Math.round(r.avgWatchPct)}%</span> avg watched
          </p>
        ) : r.engagement != null ? (
          <p className="mt-2 text-xs text-teal-text">
            Score <span className="tnum font-semibold">{Math.round(r.engagement)}</span>
          </p>
        ) : (
          <p className="mt-2 text-xs text-faint">No numbers</p>
        )}
      </div>
    </li>
  )
}

function BrandMemory() {
  const brand = useBrand()
  return (
    <Card title="Brand memory">
      <p className="mb-4 text-[13px] text-muted">
        What {AI.name} uses when it adds captions and titles. Edit it any time in Settings.
      </p>
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Heading font</dt>
          <dd className="font-medium">{brand.fonts.heading}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Body font</dt>
          <dd className="font-medium">{brand.fonts.body}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Colours</dt>
          <dd className="flex gap-1.5">
            {Object.entries(brand.colors).map(([k, c]) => (
              <span
                key={k}
                title={`${k} ${c}`}
                className="size-6 rounded-full border border-line"
                style={{ background: c }}
              >
                <span className="sr-only">
                  {k} {c}
                </span>
              </span>
            ))}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Logo</dt>
          <dd className="font-medium">{brand.logoName ?? 'Not added'}</dd>
        </div>
      </dl>
      <Link
        to="/app/settings#brand"
        className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
      >
        <Palette className="size-3.5" aria-hidden="true" /> Edit brand kit
      </Link>
    </Card>
  )
}

function Profile({ p, reels }: { p: StyleProfile; reels: ReelMetric[] }) {
  const disconnect = useDisconnectStyle()
  const sync = useSyncStyle()
  const hasRetention = p.hookRetention.length > 0
  const avgRetention = hasRetention
    ? Math.round(p.hookRetention.reduce((a, b) => a + b, 0) / p.hookRetention.length)
    : 0
  const max = Math.max(...p.hookRetention, 1)
  const learned = p.reelsAnalysed > 0
  const columns = p.music.length ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-surface-1 p-5">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-2 rounded-full bg-teal" aria-hidden="true" />
            {p.source === 'instagram'
              ? `Connected to Instagram ${p.handle ?? ''}`
              : 'Learned from uploaded Reels'}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">{p.reelsAnalysed} Reels analysed</p>
          {p.summary && <p className="mt-2 max-w-xl text-[13px]">{p.summary}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {isReal && p.source === 'instagram' && (
            <Button
              variant="secondary"
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () =>
                    toast({
                      title: 'Reading your Reels',
                      description: 'This takes a minute.',
                      tone: 'info',
                    }),
                  onError: (e) =>
                    toast({
                      title: 'Could not refresh',
                      description: e instanceof ApiError ? e.message : 'Please try again.',
                      tone: 'error',
                    }),
                })
              }
            >
              Refresh from Instagram
            </Button>
          )}
          <Button
            variant="ghost"
            leading={<Unlink className="size-4" aria-hidden="true" />}
            loading={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () =>
                  toast({
                    title: 'Disconnected',
                    description: 'Your learned style was removed.',
                    tone: 'info',
                  }),
              })
            }
          >
            Disconnect
          </Button>
        </div>
      </div>

      {learned && p.confidence === 'low' && (
        <div
          role="status"
          className="rounded-panel border border-saffron/40 bg-saffron-soft p-4 text-[13px]"
        >
          <p className="font-semibold">This is a first guess</p>
          <p className="mt-0.5 text-muted">
            Your style is learned from few Reels, or from Reels with no numbers to tell the best
            from the rest. Add more Reels
            {isReal ? ' below' : ''} for a sharper match.
          </p>
        </div>
      )}

      {learned ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Hook lands at"
              value={`${p.hookTimingSec.toFixed(1)}s`}
              note="Your first big moment"
            />
            <Stat label="Cut pace" value={`${p.cutPace.toFixed(1)}`} note="Cuts every 10 seconds" />
            <Stat
              label="Hook retention"
              value={hasRetention ? `${avgRetention}%` : '–'}
              note={hasRetention ? 'Still watching at 3 seconds' : 'Instagram has not shared this'}
            />
          </div>

          <div className={`grid gap-5 ${columns}`}>
            <Card title="Captions you use">
              {p.captionStyles.length ? (
                <Bars
                  label="Caption styles"
                  rows={p.captionStyles.map((c) => ({ label: styleName(c.id), share: c.share }))}
                />
              ) : (
                <p className="text-sm text-muted">No captions seen.</p>
              )}
            </Card>
            {p.music.length > 0 && (
              <Card title="Music">
                <Bars label="Music types" rows={p.music} />
              </Card>
            )}
            <Card title="Retention, last Reels">
              {hasRetention ? (
                <div
                  role="img"
                  aria-label={`Hook retention for your last ${p.hookRetention.length} Reels: ${p.hookRetention.join('%, ')}%`}
                  className="flex h-32 items-end gap-2"
                >
                  {p.hookRetention.map((v, i) => (
                    <div
                      key={i}
                      className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                    >
                      <span className="tnum text-[10px] text-faint">{v}</span>
                      <div
                        className="w-full rounded-t-md bg-teal"
                        style={{ height: `calc(${(v / max) * 100}% - 1.25rem)` }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Instagram shares this only for some Reels. It shows here when it does.
                </p>
              )}
            </Card>
          </div>
        </>
      ) : (
        isReal && (
          <UploadReels
            title="Add your best Reels"
            hint="Pick 3 to 5 of the Reels that did best, up to 90 seconds each. Your files are deleted as soon as they have been watched: only numbers and a small picture are kept."
          />
        )
      )}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title="Your top Reels">
          {reels.length === 0 ? (
            <p className="text-sm text-muted">No Reels to show yet.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {reels.map((r) => (
                <ReelCard key={r.id} r={r} />
              ))}
            </ul>
          )}
        </Card>
        <div className="flex flex-col gap-5">
          {learned && (
            <Card title="Fonts and colours seen">
              <p className="mb-2 text-xs text-muted">Fonts</p>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {p.fonts.length ? (
                  p.fonts.map((f) => (
                    <span key={f} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs">
                      {f}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-faint">Not detected</span>
                )}
              </div>
              <p className="mb-2 text-xs text-muted">Colours</p>
              <div className="flex gap-1.5">
                {p.colors.length ? (
                  p.colors.map((c) => (
                    <span
                      key={c}
                      className="size-7 rounded-full border border-line"
                      style={{ background: c }}
                    >
                      <span className="sr-only">{c}</span>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-faint">Not detected</span>
                )}
              </div>
            </Card>
          )}
          {isReal && learned && (
            <UploadReels
              title="Add more Reels"
              hint="More Reels, and their numbers, make the match sharper."
              existing={reels.filter((r) => r.source === 'upload').length}
            />
          )}
          <BrandMemory />
        </div>
      </div>
    </div>
  )
}

export function StylePage() {
  const style = useStyle()
  const reels = useReels()
  const status = useStyleStatus()
  const qc = useQueryClient()
  const reconnect = useStartInstagram()
  const [params, setParams] = useSearchParams()
  // Instagram sends the person back here with ?connected=1, or ?connected=0&reason=...; read it once, then tidy the address.
  const [notice, setNotice] = useState<Notice | null>(() =>
    isReal ? connectNotice(params.get('connected'), params.get('reason')) : null,
  )
  useEffect(() => {
    if (!params.has('connected')) return
    setParams({}, { replace: true })
    if (params.get('connected') === '1') {
      void qc.invalidateQueries({ queryKey: keys.styleStatus })
      void qc.invalidateQueries({ queryKey: keys.style })
    }
  }, [params, setParams, qc])

  // When reading or learning finishes, show what it found.
  const before = useRef<string | undefined>(undefined)
  const state = status.data?.state
  useEffect(() => {
    const was = before.current
    before.current = state
    if (
      (was === 'analysing' || was === 'syncing') &&
      state !== 'analysing' &&
      state !== 'syncing'
    ) {
      void qc.invalidateQueries({ queryKey: keys.style })
      void qc.invalidateQueries({ queryKey: keys.reels })
    }
  }, [state, qc])

  const connected = !!style.data?.connected
  const view = describeStatus(status.data, connected)
  const again = () =>
    reconnect.mutate(undefined, {
      onSuccess: (r) => window.location.assign(r.authUrl),
      onError: () =>
        toast({ title: 'Could not reconnect', description: 'Please try again.', tone: 'error' }),
    })
  const action =
    view.kind === 'reconnect'
      ? { label: 'Reconnect', onClick: again, loading: reconnect.isPending }
      : view.kind === 'problem'
        ? { label: 'Check again', onClick: () => void status.refetch() }
        : undefined
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-semibold">Your style</h1>
      <p className="mb-6 mt-1 text-muted">
        How you like your Reels to look and move, so {AI.name} edits the way you would.
      </p>
      {notice && <NoticeCard notice={notice} onDismiss={() => setNotice(null)} />}
      {isReal && <StatusBanner view={view} failed={status.data?.failed} action={action} />}
      {style.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-5">
          <Skeleton className="h-24 rounded-panel" />
          <Skeleton className="h-64 rounded-panel" />
        </div>
      ) : style.isError || !style.data ? (
        <EmptyState
          title="Could not load your style"
          description="Check your connection and try again."
          action={
            <Button variant="primary" onClick={() => void style.refetch()}>
              Try again
            </Button>
          }
        />
      ) : style.data.connected ? (
        <Profile p={style.data} reels={reels.data ?? []} />
      ) : view.kind === 'working' ? (
        <BrandMemory />
      ) : (
        <>
          <ConnectCard />
          <div className="mt-5">
            <BrandMemory />
          </div>
        </>
      )}
    </div>
  )
}

export default StylePage
