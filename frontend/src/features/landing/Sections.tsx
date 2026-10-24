import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Clapperboard, Film, Scissors, Smartphone } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/cn'
import { AI } from '@/lib/config'

/* ------------------------------ Works with ------------------------------ */

const WORKS = [
  { name: 'Premiere Pro', icon: Clapperboard },
  { name: 'DaVinci Resolve', icon: Film },
  { name: 'Final Cut Pro', icon: Scissors },
  { name: 'Instagram', icon: Smartphone },
]

export function WorksWith() {
  return (
    <section aria-labelledby="works-h" className="border-y border-line bg-surface-1/60 py-10">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 sm:px-6 md:flex-row md:justify-between">
        <h2 id="works-h" className="text-sm font-semibold text-muted">
          Works with the tools you already use
        </h2>
        <ul className="flex flex-wrap items-center justify-center gap-3">
          {WORKS.map((w) => (
            <li
              key={w.name}
              className="flex items-center gap-2.5 rounded-full border border-line bg-surface-1 py-2 pl-3 pr-4 text-sm font-medium"
            >
              <w.icon className="size-4 text-accent" aria-hidden="true" />
              {w.name}
            </li>
          ))}
        </ul>
      </div>
      <p className="mx-auto mt-5 max-w-7xl px-4 text-center text-xs text-faint sm:px-6 md:text-left">
        Editor export uses the open OpenTimelineIO format. Product names belong to their owners.
      </p>
    </section>
  )
}

/* ----------------------------- How it works ----------------------------- */

const STEPS = [
  {
    n: '1',
    title: 'Upload',
    copy: 'Drop in one long video. It is split, transcribed in Hindi and English, and indexed in minutes.',
  },
  {
    n: '2',
    title: 'Chat',
    copy: `Tell ${AI.name} what you want. Review each change as a card, apply it, undo it, or edit the transcript yourself.`,
  },
  {
    n: '3',
    title: 'Export',
    copy: 'Download 9:16 Reels with captions, or send the whole timeline to Premiere, DaVinci or Final Cut.',
  },
]

export function HowItWorks() {
  return (
    <section
      id="how"
      className="scroll-mt-20 py-20 [content-visibility:auto] [contain-intrinsic-size:auto_520px]"
      aria-labelledby="how-h"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2
          id="how-h"
          className="mb-12 max-w-2xl text-4xl font-bold tracking-[-0.04em] sm:text-5xl"
        >
          Three steps from long video to posted.
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative rounded-[24px] border border-line bg-surface-1 p-7">
              <span className="mb-6 flex size-11 items-center justify-center rounded-full bg-saffron text-lg font-bold text-saffron-ink">
                {s.n}
              </span>
              <h3 className="text-2xl font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{s.copy}</p>
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-3 top-1/2 hidden h-12 -translate-y-1/2 md:block"
                >
                  <i className="cut-line cut-line--v block h-full" />
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/* -------------------------------- Pricing ------------------------------- */

const PLANS = [
  {
    name: 'Free',
    price: '₹0',
    per: 'to start',
    popular: false,
    features: [
      '30 minutes of video a month',
      '720p Reel exports',
      'Chat, transcript and search',
      'Small Lypcut watermark',
    ],
  },
  {
    name: 'Creator',
    price: '₹799',
    per: 'a month',
    popular: true,
    features: [
      '10 hours of video a month',
      '1080 x 1920 exports, no watermark',
      'Export to Premiere, DaVinci, Final Cut',
      'Learns your style from Instagram',
    ],
  },
  {
    name: 'Studio',
    price: '₹2,499',
    per: 'a month',
    popular: false,
    features: [
      '40 hours of video a month',
      'Brand kits and caption templates',
      'Priority processing',
      '3 team seats',
    ],
  },
]

export function Pricing() {
  return (
    <section
      id="pricing"
      className="scroll-mt-20 py-20 [content-visibility:auto] [contain-intrinsic-size:auto_640px]"
      aria-labelledby="price-h"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-12 max-w-2xl">
          <p className="mb-3 text-sm font-semibold text-accent">Pricing preview</p>
          <h2 id="price-h" className="text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
            Start free. Pay when it pays you back.
          </h2>
          <p className="mt-4 text-muted">
            Illustrative prices while we are in preview. Billing is not live yet.
          </p>
        </div>
        <ul className="grid gap-4 md:grid-cols-3">
          {PLANS.map((p) => (
            <li
              key={p.name}
              className={cn(
                'relative flex flex-col rounded-[24px] border bg-surface-1 p-7',
                p.popular ? 'border-saffron/60 shadow-lift' : 'border-line',
              )}
            >
              {p.popular && (
                <span className="absolute -top-3 left-7">
                  <Badge tone="saffron" className="bg-saffron text-saffron-ink">
                    Most creators pick this
                  </Badge>
                </span>
              )}
              <h3 className="text-lg font-semibold">{p.name}</h3>
              <p className="mt-3 flex items-baseline gap-1.5">
                <span className="tnum text-5xl font-bold tracking-tight">{p.price}</span>
                <span className="text-sm text-muted">{p.per}</span>
              </p>
              <ul className="mt-6 flex-1 space-y-3">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5 text-[15px] text-muted">
                    <Check className="mt-0.5 size-4 shrink-0 text-teal-text" aria-hidden="true" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button asChild variant={p.popular ? 'primary' : 'secondary'} className="mt-8">
                <Link to="/signup">Start free</Link>
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/* --------------------------------- FAQ ---------------------------------- */

const FAQ = [
  {
    q: 'Does it really work with Hindi and Hinglish?',
    a: 'Yes. Transcripts keep Hindi and English words in the same sentence and show them in Devanagari or Roman, your choice. Captions render both cleanly, and you can talk to the assistant in either.',
  },
  {
    q: 'Am I stuck with what the AI does?',
    a: 'Never. Every AI action is a card with Preview, Apply and Undo, and every version is saved in History. The timeline stays fully editable, so you can trim, split and move clips yourself.',
  },
  {
    q: 'Which editors can I export to?',
    a: 'You can export the timeline as OpenTimelineIO, which opens in DaVinci Resolve and can be brought into Premiere Pro and Final Cut Pro with their import tools. CapCut export is coming soon, once we have verified it end to end.',
  },
  {
    q: 'Does it post to Instagram for me?',
    a: 'No. You download your Reels and post them yourself. If you connect Instagram, Lypcut only reads your public Reels metrics to learn your style, and you can disconnect any time.',
  },
  {
    q: 'What happens to my videos?',
    a: 'They are yours. You can delete a project, or your whole account and its data, from Settings whenever you like.',
  },
  {
    q: 'How much does it cost?',
    a: 'You can start free. Paid plans are shown above as a preview, and billing is not switched on yet.',
  },
]

function FaqItem({
  q,
  a,
  open,
  onToggle,
  id,
}: {
  q: string
  a: string
  open: boolean
  onToggle: () => void
  id: string
}) {
  return (
    <div className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          id={`${id}-btn`}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-4 py-5 text-left text-lg font-medium"
        >
          {q}
          <ChevronDown
            className={cn(
              'size-5 shrink-0 text-faint transition-transform duration-200',
              open && 'rotate-180 text-accent',
            )}
            aria-hidden="true"
          />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-panel`}
            role="region"
            aria-labelledby={`${id}-btn`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <p className="max-w-2xl pb-5 leading-relaxed text-muted">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section
      id="faq"
      className="scroll-mt-20 py-20 [content-visibility:auto] [contain-intrinsic-size:auto_640px]"
      aria-labelledby="faq-h"
    >
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.6fr]">
        <h2 id="faq-h" className="text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
          Questions, answered.
        </h2>
        <div className="border-t border-line">
          {FAQ.map((f, i) => (
            <FaqItem
              key={f.q}
              id={`faq-${i}`}
              q={f.q}
              a={f.a}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ Final CTA, footer ----------------------- */

export function FinalCta() {
  return (
    <section className="px-4 pb-24 sm:px-6" aria-labelledby="cta-h">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 rounded-[28px] border border-line bg-surface-1 px-8 py-12 shadow-[var(--sh-soft)] sm:px-14 sm:py-14 lg:flex-row lg:items-center lg:justify-between lg:gap-16">
        <div className="max-w-xl">
          <h2 id="cta-h" className="text-4xl font-bold tracking-[-0.045em] sm:text-5xl">
            Your next edit is one sentence away.
          </h2>
          <p className="mt-4 text-lg text-muted">
            Your first project is free. Upload a long video and tell Kaat what to do with it.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:shrink-0">
          <Button asChild size="lg" variant="primary">
            <Link to="/signup">Start free</Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <a href="#how">See how it works</a>
          </Button>
        </div>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="border-t border-line py-12">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 sm:px-6 md:flex-row md:justify-between">
        <div className="max-w-xs">
          <Logo size={26} />
          <p className="mt-4 text-sm text-muted">
            AI video editing for creators, in Hindi, Hinglish and English.
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-14 gap-y-3 text-sm sm:grid-cols-3"
        >
          {[
            ['Features', '#features'],
            ['How it works', '#how'],
            ['Pricing', '#pricing'],
            ['FAQ', '#faq'],
            ['Log in', '/login'],
            ['Start free', '/signup'],
          ].map(([label, href]) =>
            href!.startsWith('#') ? (
              <a key={label} href={href} className="text-muted hover:text-text">
                {label}
              </a>
            ) : (
              <Link key={label} to={href!} className="text-muted hover:text-text">
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <p className="mx-auto mt-10 max-w-7xl px-4 text-xs text-faint sm:px-6">
        © {new Date().getFullYear()} Lypcut. This is a front-end preview: uploads, AI and billing
        are simulated.
      </p>
    </footer>
  )
}
