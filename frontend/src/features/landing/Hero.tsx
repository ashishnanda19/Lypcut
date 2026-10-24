import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Play } from 'lucide-react'
import { CutLine } from '@/components/brand/CutLine'
import { Button } from '@/components/ui/Button'
import { Decorative } from '@/components/ui/Decorative'
import { EditCard } from '@/components/domain/EditCard'
import { PhoneFrame } from '@/components/domain/PhoneFrame'
import { MiniTimeline, type Seg } from './MiniTimeline'

const LINES = [
  { lang: 'hi', text: 'बोलिए, वीडियो एडिट हो जाएगा।' },
  { lang: 'hinglish', text: 'Bolo, video edit ho jayega.' },
] as const

function RotatingLine() {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setI((n) => (n + 1) % LINES.length), 3200)
    return () => clearInterval(id)
  }, [])
  const line = LINES[i]!
  return (
    <div className="relative h-8 overflow-hidden" aria-hidden="true">
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={line.text}
          lang={line.lang === 'hi' ? 'hi' : undefined}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
          className="font-deva text-lg font-medium text-accent"
        >
          {line.text}
        </motion.p>
      </AnimatePresence>
    </div>
  )
}

const CAPTION = ['फंडिंग', 'कैसे', 'रेज़', 'करें']

function HeroPhone() {
  const ref = useRef<HTMLVideoElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) v.play().catch(() => undefined)
      else v.pause()
    })
    io.observe(v)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setActive((n) => (n + 1) % CAPTION.length), 520)
    return () => clearInterval(id)
  }, [])

  return (
    <PhoneFrame width={252} safeZones={false}>
      <video
        ref={ref}
        src="/demo/presenter-hd.mp4"
        poster="/demo/presenter-poster.jpg"
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
        aria-label="Looping demo of an edited Reel"
        className="absolute inset-0 h-full w-full object-cover object-[50%_22%]"
      />
      <div
        className="absolute inset-x-3 bottom-[24%] z-10 text-center"
        lang="hi"
        aria-hidden="true"
      >
        <p className="font-deva text-[23px] font-extrabold leading-tight text-white [text-shadow:0_2px_14px_rgb(0_0_0/0.8)]">
          {CAPTION.map((w, i) => (
            <span
              key={w}
              className={
                i === active
                  ? 'mx-0.5 inline-block rounded-md bg-saffron px-1.5 text-saffron-ink transition-transform [transform:scale(1.08)]'
                  : 'mx-0.5 inline-block px-1'
              }
            >
              {w}
            </span>
          ))}
        </p>
      </div>
    </PhoneFrame>
  )
}

const HERO_SEGS: Seg[] = [
  { id: '1', w: 5, kind: 'keep' },
  { id: '2', w: 1, kind: 'filler' },
  { id: '3', w: 4, kind: 'keep' },
  { id: '4', w: 1.4, kind: 'pause' },
  { id: '5', w: 6, kind: 'keep' },
  { id: '6', w: 3, kind: 'hook' },
]

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden" aria-labelledby="hero-h">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-40 -top-40 size-[34rem] rounded-full bg-saffron/15 blur-[110px]" />
        <div className="absolute -bottom-40 right-0 size-[30rem] rounded-full bg-teal/15 blur-[110px]" />
        <div className="absolute inset-0 [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" />
      </div>

      <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.08fr_1fr] lg:pb-28 lg:pt-20">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface-1 py-1 pl-1.5 pr-3.5 text-[13px] font-medium text-muted">
            <span className="rounded-full bg-saffron px-2.5 py-0.5 text-xs font-bold text-saffron-ink">
              New
            </span>
            Understands Hindi, Hinglish and English
          </p>
          <h1
            id="hero-h"
            className="text-[clamp(2.7rem,6.6vw,5.4rem)] font-bold leading-[1.01] tracking-[-0.047em]"
          >
            Edit your video
            <br />
            <span className="relative inline-block">
              by <span className="text-saffron">talking</span> to it.
              <span aria-hidden="true" className="absolute -right-3 -top-3 bottom-[-0.35em] w-0.5">
                <CutLine flash flashKey="hero" />
              </span>
            </span>
          </h1>
          <div className="mt-5">
            <RotatingLine />
          </div>
          <p className="mt-4 max-w-[31rem] text-lg leading-relaxed text-muted">
            Upload a podcast, vlog or lecture and tell Kaat what you want: “remove the fillers”,
            “make the hook punchier”. Every change is a real edit you can preview, undo and export.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" variant="primary">
              <Link to="/signup">
                Start free
                <ArrowRight className="size-5" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <a href="#demo">
                <Play className="size-4" aria-hidden="true" />
                Watch it work
              </a>
            </Button>
          </div>
          <p className="mt-5 text-sm text-faint">
            No card needed. Your edit stays a real timeline you can export.
          </p>
        </div>

        <div className="relative mx-auto flex w-full max-w-[34rem] justify-center pb-10 pt-4 sm:pb-16">
          <HeroPhone />
          <Decorative className="absolute bottom-0 hidden w-[17rem] lg:-left-24 lg:block xl:-left-28">
            <EditCard
              title="Remove 3 fillers and 1 long pause"
              description="Cuts “matlab”, “basically”, “um” and a 2.4s pause."
              status="applied"
              strip={[
                { kind: 'keep', weight: 6 },
                { kind: 'cut', weight: 1 },
                { kind: 'keep', weight: 9 },
                { kind: 'cut', weight: 2 },
                { kind: 'keep', weight: 7 },
              ]}
              summary={[
                { label: 'Cuts', value: '4', tone: 'coral' },
                { label: 'Saved', value: '0:04', tone: 'teal' },
              ]}
            />
          </Decorative>
          <Decorative className="glass absolute -right-1 top-6 hidden w-52 rounded-card p-3 sm:block lg:-right-6">
            <p className="mb-2 text-xs font-medium text-muted">Your timeline</p>
            <MiniTimeline segs={HERO_SEGS} removed={['filler', 'pause']} playKey={1} />
          </Decorative>
        </div>
      </div>
    </section>
  )
}
