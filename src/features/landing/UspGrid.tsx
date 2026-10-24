import type { CSSProperties, ReactNode } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { AiMark } from '@/components/brand/AiMark'
import { cn } from '@/lib/cn'
import { AI } from '@/lib/config'

/* Tiny looping pictures, one per promise. Pure CSS, aria-hidden, paused for reduced motion. */

const Dots = () => (
  <span className="flex gap-1" aria-hidden="true">
    {[0, 1, 2].map((i) => (
      <i
        key={i}
        className="size-1.5 rounded-full bg-muted"
        style={{ animation: 'usp-dots 1.2s ease-in-out infinite', animationDelay: `${i * 0.15}s` }}
      />
    ))}
  </span>
)

function ChatVisual() {
  return (
    <div className="flex h-full flex-col justify-end gap-2" aria-hidden="true">
      <p className="ml-auto w-fit rounded-2xl rounded-br-md border border-saffron/25 bg-saffron-soft px-3 py-1.5 text-[13px]">
        Best hook dhoondo
      </p>
      <div className="flex items-start gap-2">
        <AiMark size={22} thinking />
        <div className="rounded-2xl rounded-tl-md bg-surface-2 px-3 py-2.5">
          <Dots />
        </div>
      </div>
      <div className="rounded-xl border border-line bg-surface-1 px-3 py-2 text-xs text-muted [animation:usp-cycle_6s_ease-in-out_infinite]">
        <span className="font-semibold text-text">Edit card</span> · Keep 0:52 to 1:22 · Preview ·
        Apply
      </div>
    </div>
  )
}

function TranscriptVisual() {
  return (
    <p lang="hi" className="font-deva text-[17px] leading-[2.2]" aria-hidden="true">
      तो{' '}
      <span className="rounded px-0.5 [animation:usp-strike_5s_ease-in-out_infinite] [background:linear-gradient(var(--coral),var(--coral))_left_center/0%_2px_no-repeat]">
        बेसिकली
      </span>{' '}
      आज हम फंडिंग की बात <span className="rounded bg-saffron px-1 text-saffron-ink">करेंगे</span>
    </p>
  )
}

function SearchVisual() {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      <div className="flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3.5 py-2">
        <Search className="size-4 text-faint" />
        <span className="overflow-hidden whitespace-nowrap text-[13px] [animation:usp-type_6s_steps(18)_infinite]">
          funding wali baat
        </span>
      </div>
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-line bg-surface-1 p-1.5 pr-3 [animation:usp-cycle_6s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 0.25}s` }}
        >
          <span className="h-9 w-14 shrink-0 rounded-lg bg-[linear-gradient(120deg,var(--saffron-soft),var(--teal-soft))]" />
          <span className="tnum text-xs text-muted">{i ? '3:12 – 3:34' : '0:52 – 1:19'}</span>
          <span className="ml-auto text-xs font-semibold text-accent">{i ? 87 : 94}</span>
        </div>
      ))}
    </div>
  )
}

function PhoneVisual() {
  const words = ['फंडिंग', 'कैसे', 'रेज़']
  return (
    <div className="flex justify-center" aria-hidden="true">
      <div className="w-24 rounded-[1.6rem] border border-line-strong bg-[#07090c] p-1.5">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[1.25rem] bg-[linear-gradient(160deg,var(--saffron-soft),var(--teal-soft)_70%,#0b0d11)]">
          <p
            lang="hi"
            className="absolute inset-x-1 bottom-[26%] text-center font-deva text-[11px] font-extrabold leading-tight"
          >
            {words.map((w, i) => (
              <span
                key={w}
                className="mx-px inline-block rounded px-0.5"
                style={{ animation: 'usp-word 3s ease-in-out infinite', animationDelay: `${i}s` }}
              >
                {w}
              </span>
            ))}
          </p>
        </div>
      </div>
    </div>
  )
}

function HistoryVisual() {
  const rows = [
    ['AI', 'Added captions'],
    ['You', 'Trimmed intro'],
    ['AI', 'Removed 3 fillers'],
    ['Start', 'Original upload'],
  ]
  return (
    <div className="relative space-y-1" aria-hidden="true">
      <span className="absolute inset-x-0 top-0 h-8 rounded-xl border border-saffron/50 bg-saffron-soft [animation:usp-pick_5s_ease-in-out_infinite]" />
      {rows.map(([who, what]) => (
        <div key={what} className="relative flex h-8 items-center gap-2.5 px-2.5 text-xs">
          <span
            className={cn(
              'w-9 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold',
              who === 'AI'
                ? 'bg-saffron-soft text-accent'
                : who === 'You'
                  ? 'bg-teal-soft text-teal-text'
                  : 'bg-surface-3 text-muted',
            )}
          >
            {who}
          </span>
          <span className="text-muted">{what}</span>
        </div>
      ))}
    </div>
  )
}

function TimelineVisual() {
  const lane = (cls: string, items: Array<[number, number]>) => (
    <div className="relative h-5 rounded-md bg-surface-2">
      {items.map(([l, w], i) => (
        <span
          key={i}
          className={cn('absolute inset-y-0.5 rounded', cls)}
          style={{ left: `${l}%`, width: `${w}%` }}
        />
      ))}
    </div>
  )
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="space-y-1.5">
        {lane('border border-saffron/50 bg-saffron-soft', [
          [2, 30],
          [34, 22],
          [58, 38],
        ])}
        {lane('border border-teal/50 bg-teal-soft', [
          [16, 14],
          [62, 16],
        ])}
        {lane('bg-surface-3', [[2, 94]])}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <ArrowRight className="size-4 text-faint" />
        {['.otio', 'Premiere Pro', 'DaVinci', 'Final Cut'].map((c, i) => (
          <span
            key={c}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              i === 0 ? 'bg-saffron-soft text-accent' : 'bg-surface-3 text-muted',
            )}
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  )
}

function ScriptVisual() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3" aria-hidden="true">
      <div className="relative h-12 w-full text-center">
        <span
          lang="hi"
          className="font-deva absolute inset-0 text-[34px] font-bold [animation:usp-swap-a_4s_ease-in-out_infinite]"
        >
          फंडिंग
        </span>
        <span className="absolute inset-0 text-[34px] font-bold tracking-tight [animation:usp-swap-b_4s_ease-in-out_infinite]">
          funding
        </span>
      </div>
      <div className="flex gap-1.5">
        {['हिन्दी', 'Hinglish', 'English'].map((c) => (
          <span
            key={c}
            lang={c === 'हिन्दी' ? 'hi' : undefined}
            className="rounded-full bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium text-muted"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  )
}

function StyleVisual() {
  const hs = [40, 58, 46, 72, 64, 88, 80, 96]
  return (
    <div className="flex h-full flex-col justify-end gap-3" aria-hidden="true">
      <div className="flex h-20 items-end gap-1.5">
        {hs.map((h, i) => (
          <span
            key={i}
            className={cn('w-full origin-bottom rounded-t-md', i > 4 ? 'bg-saffron' : 'bg-teal/60')}
            style={
              {
                height: `${h}%`,
                animation: 'usp-bar 3.2s ease-in-out infinite',
                animationDelay: `${i * 0.12}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="flex gap-1.5">
        <span className="rounded-full bg-saffron-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
          Hook in 1.6s
        </span>
        <span className="rounded-full bg-teal-soft px-2.5 py-0.5 text-[11px] font-medium text-teal-text">
          3.4 cuts / 10s
        </span>
      </div>
    </div>
  )
}

interface Usp {
  title: string
  copy: string
  visual: ReactNode
  span: string
}

const USPS: Usp[] = [
  {
    title: 'Chat-first editing',
    copy: `Just say it. ${AI.name} cuts, trims and captions, and every change lands on the timeline the moment it happens.`,
    visual: <ChatVisual />,
    span: 'lg:col-span-2',
  },
  {
    title: 'Edit by transcript',
    copy: 'Delete a word and that part of the video is cut. Fillers go in one click.',
    visual: <TranscriptVisual />,
    span: 'lg:col-span-1',
  },
  {
    title: 'Find the moment',
    copy: 'Type “where I talk about funding”. Get the clip, with a thumbnail and timestamps.',
    visual: <SearchVisual />,
    span: 'lg:col-span-1',
  },
  {
    title: 'Live Reel preview',
    copy: 'A 9:16 phone preview that always shows exactly what you will export.',
    visual: <PhoneVisual />,
    span: 'lg:col-span-1',
  },
  {
    title: 'Fearless version history',
    copy: 'Undo any AI action in one click. Every version is saved, nothing is lost.',
    visual: <HistoryVisual />,
    span: 'lg:col-span-1',
  },
  {
    title: 'A real, editable timeline',
    copy: 'Not a locked MP4. Export to Premiere Pro, DaVinci Resolve and Final Cut Pro.',
    visual: <TimelineVisual />,
    span: 'lg:col-span-2',
  },
  {
    title: 'Hindi and Hinglish first',
    copy: 'Transcripts and captions in Devanagari or Roman, with mixed Hindi and English sentences handled cleanly.',
    visual: <ScriptVisual />,
    span: 'lg:col-span-2',
  },
  {
    title: 'Learns your style',
    copy: `Connect Instagram and ${AI.name} learns what works from your own hit Reels: hook timing, pace, captions.`,
    visual: <StyleVisual />,
    span: 'lg:col-span-2',
  },
]

export function UspGrid() {
  return (
    <section
      id="features"
      className="scroll-mt-20 py-20 [content-visibility:auto] [contain-intrinsic-size:auto_1200px]"
      aria-labelledby="usp-h"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-12 max-w-2xl">
          <p className="mb-3 text-sm font-semibold text-accent">Why creators switch</p>
          <h2 id="usp-h" className="text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
            Built for the way you actually talk and cut.
          </h2>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USPS.map((u) => (
            <li
              key={u.title}
              className={cn(
                'group flex min-h-[19rem] flex-col rounded-[24px] border border-line bg-surface-1 p-6 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-soft',
                u.span,
              )}
            >
              <div className="mb-5 min-h-[9.5rem] flex-1">{u.visual}</div>
              <h3 className="text-lg font-semibold tracking-tight">{u.title}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{u.copy}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
