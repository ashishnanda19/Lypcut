import { useState } from 'react'
import { Link } from 'react-router-dom'
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
} from 'lucide-react'
import {
  useConnectStyle,
  useDisconnectStyle,
  useReels,
  useStyle,
  useUploadStyle,
} from '@/api/hooks'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { toast } from '@/components/ui/Toast'
import { captionStyle } from '@/features/editor/captionStyles'
import { AI } from '@/lib/config'
import { compactNumber, timeAgo } from '@/lib/format'
import { formatDuration } from '@/lib/time'
import { useBrand } from '@/stores/brand'
import type { ReelMetric, StyleProfile } from '@/types'

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

function ConnectCard() {
  const connect = useConnectStyle()
  const upload = useUploadStyle()
  const [count, setCount] = useState('5')
  const busy = connect.isPending || upload.isPending
  return (
    <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
      <section className="rounded-panel border border-line bg-surface-1 p-6">
        <span className="grid size-11 place-items-center rounded-full bg-saffron-soft text-accent">
          <Link2 className="size-5" aria-hidden="true" />
        </span>
        <h2 className="mt-4 text-xl font-semibold">Teach {AI.name} your style</h2>
        <p className="mt-1 text-sm text-muted">
          Connect Instagram and {AI.name} learns how you cut: how fast, how long your hooks are,
          which captions you use. Then “Apply my style” does it for you.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-teal-text">
              <Check className="size-3.5" aria-hidden="true" /> What we read
            </p>
            <ul className="space-y-1.5 text-[13px] text-muted">
              <li>Your public Reels and their captions</li>
              <li>Views, likes, saves, shares, watch time</li>
              <li>Fonts, colours and pacing in your videos</li>
            </ul>
          </div>
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
              <Lock className="size-3.5" aria-hidden="true" /> What we never touch
            </p>
            <ul className="space-y-1.5 text-[13px] text-muted">
              <li>Your password or private messages</li>
              <li>Your followers list</li>
              <li>We never post for you</li>
            </ul>
          </div>
        </div>
        <Button
          className="mt-6"
          variant="primary"
          size="lg"
          loading={connect.isPending}
          disabled={busy}
          onClick={() =>
            connect.mutate(undefined, {
              onSuccess: () =>
                toast({
                  title: 'Instagram connected',
                  description: `${AI.name} read your Reels.`,
                  tone: 'success',
                }),
              onError: () =>
                toast({
                  title: 'Could not connect',
                  description: 'Please try again.',
                  tone: 'error',
                }),
            })
          }
        >
          Connect Instagram
        </Button>
        <p className="mt-3 text-xs text-faint">
          Demo build: this is a simulated connection, no real Instagram sign-in happens.
        </p>
      </section>

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
    </div>
  )
}

function ReelCard({ r }: { r: ReelMetric }) {
  return (
    <li className="overflow-hidden rounded-card border border-line bg-surface-1">
      <PlaceholderThumb seed={r.thumbSeed} aspect="reel" className="w-full">
        <span className="tnum absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
          {formatDuration(r.durationSec)}
        </span>
      </PlaceholderThumb>
      <div className="p-3">
        <p className="line-clamp-2 text-[13px] font-medium">{r.title}</p>
        <p className="mt-0.5 text-xs text-faint">{timeAgo(r.postedAt)}</p>
        <dl className="tnum mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted">
          <div className="flex items-center gap-1">
            <Eye className="size-3" aria-hidden="true" />
            <dt className="sr-only">Views</dt>
            <dd>{compactNumber(r.views)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Heart className="size-3" aria-hidden="true" />
            <dt className="sr-only">Likes</dt>
            <dd>{compactNumber(r.likes)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Bookmark className="size-3" aria-hidden="true" />
            <dt className="sr-only">Saves</dt>
            <dd>{compactNumber(r.saves)}</dd>
          </div>
          <div className="flex items-center gap-1">
            <Share2 className="size-3" aria-hidden="true" />
            <dt className="sr-only">Shares</dt>
            <dd>{compactNumber(r.shares)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-teal-text">
          <span className="tnum font-semibold">{Math.round(r.avgWatchPct)}%</span> avg watched
        </p>
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
  const avgRetention = p.hookRetention.length
    ? Math.round(p.hookRetention.reduce((a, b) => a + b, 0) / p.hookRetention.length)
    : 0
  const max = Math.max(...p.hookRetention, 1)
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
        </div>
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

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Hook lands at"
          value={`${p.hookTimingSec.toFixed(1)}s`}
          note="Your first big moment"
        />
        <Stat label="Cut pace" value={`${p.cutPace.toFixed(1)}`} note="Cuts every 10 seconds" />
        <Stat
          label="Hook retention"
          value={`${avgRetention}%`}
          note="Still watching at 3 seconds"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Captions you use">
          <Bars
            label="Caption styles"
            rows={p.captionStyles.map((c) => ({ label: captionStyle(c.id).name, share: c.share }))}
          />
        </Card>
        <Card title="Music">
          <Bars label="Music types" rows={p.music} />
        </Card>
        <Card title="Retention, last Reels">
          <div
            role="img"
            aria-label={`Hook retention for your last ${p.hookRetention.length} Reels: ${p.hookRetention.join('%, ')}%`}
            className="flex h-32 items-end gap-2"
          >
            {p.hookRetention.map((v, i) => (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <span className="tnum text-[10px] text-faint">{v}</span>
                <div
                  className="w-full rounded-t-md bg-teal"
                  style={{ height: `calc(${(v / max) * 100}% - 1.25rem)` }}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

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
          <Card title="Fonts and colours seen">
            <p className="mb-2 text-xs text-muted">Fonts</p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {p.fonts.map((f) => (
                <span key={f} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs">
                  {f}
                </span>
              ))}
            </div>
            <p className="mb-2 text-xs text-muted">Colours</p>
            <div className="flex gap-1.5">
              {p.colors.map((c) => (
                <span
                  key={c}
                  className="size-7 rounded-full border border-line"
                  style={{ background: c }}
                >
                  <span className="sr-only">{c}</span>
                </span>
              ))}
            </div>
          </Card>
          <BrandMemory />
        </div>
      </div>
    </div>
  )
}

export function StylePage() {
  const style = useStyle()
  const reels = useReels()
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-semibold">Your style</h1>
      <p className="mb-6 mt-1 text-muted">
        How you like your Reels to look and move, so {AI.name} edits the way you would.
      </p>
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
