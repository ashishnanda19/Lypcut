import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, RotateCcw } from 'lucide-react'
import { AiMark } from '@/components/brand/AiMark'
import { Button } from '@/components/ui/Button'
import { EditCard } from '@/components/domain/EditCard'
import { PhoneFrame } from '@/components/domain/PhoneFrame'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { AI } from '@/lib/config'
import { useStreamedText } from '@/lib/useStreamedText'
import { MiniTimeline, type Seg, type SegKind } from './MiniTimeline'

interface Scenario {
  id: string
  prompt: string
  reply: string
  title: string
  description: string
  removed?: SegKind[]
  onlyHook?: boolean
  captions?: boolean
  strip: { kind: 'keep' | 'cut' | 'add'; weight: number }[]
  summary: { label: string; value: string; tone?: 'neutral' | 'saffron' | 'teal' | 'coral' }[]
  caption: string
}

const SEGS: Seg[] = [
  { id: 'a', w: 5, kind: 'keep' },
  { id: 'b', w: 1, kind: 'filler' },
  { id: 'c', w: 4, kind: 'keep' },
  { id: 'd', w: 1.5, kind: 'pause' },
  { id: 'e', w: 3, kind: 'hook' },
  { id: 'f', w: 5, kind: 'keep' },
  { id: 'g', w: 1, kind: 'filler' },
  { id: 'h', w: 4, kind: 'keep' },
]

const SCENARIOS: Scenario[] = [
  {
    id: 'fillers',
    prompt: 'Filler words aur lambe pause hata do',
    reply: 'Pakad liya! 2 filler words aur 1 lamba pause mila. Hata doon? 4 seconds bachenge.',
    title: 'Remove 2 fillers and 1 long pause',
    description: 'Cuts “matlab”, “basically” and a 2.4s pause. Nothing else changes.',
    removed: ['filler', 'pause'],
    strip: [
      { kind: 'keep', weight: 6 },
      { kind: 'cut', weight: 1 },
      { kind: 'keep', weight: 8 },
      { kind: 'cut', weight: 2 },
      { kind: 'keep', weight: 7 },
    ],
    summary: [
      { label: 'Cuts', value: '3', tone: 'coral' },
      { label: 'Saved', value: '0:04', tone: 'teal' },
    ],
    caption: 'तो आज हम बात करेंगे',
  },
  {
    id: 'reel',
    prompt: 'Make this a 30 second Reel from my best hook',
    reply:
      'Sabse strong hook 0:52 par hai, “The ₹40 lakh mistake”. Wahi rakh leta hoon, baaki hata deta hoon.',
    title: 'Keep the best hook, 0:30 Reel',
    description: 'Keeps 0:52 to 1:22 and removes the rest. Fully undoable.',
    onlyHook: true,
    strip: [
      { kind: 'cut', weight: 5 },
      { kind: 'keep', weight: 4 },
      { kind: 'cut', weight: 6 },
    ],
    summary: [
      { label: 'Length', value: '0:30', tone: 'saffron' },
      { label: 'Hook score', value: '94', tone: 'teal' },
    ],
    caption: 'मेरी सबसे बड़ी गलती',
  },
  {
    id: 'captions',
    prompt: 'Captions lagao, Devanagari mein',
    reply:
      'Ho gaya! 84 captions Devanagari mein, saffron pop style. Chaho toh style badal sakte ho.',
    title: 'Add 84 captions in Devanagari',
    description: 'Short phrases, word-by-word highlight. Placed on the Captions track.',
    captions: true,
    strip: [{ kind: 'add', weight: 12 }],
    summary: [
      { label: 'Captions', value: '84', tone: 'saffron' },
      { label: 'Style', value: 'Saffron pop', tone: 'neutral' },
    ],
    caption: 'फंडिंग कैसे रेज़ करें',
  },
]

type Phase = 'idle' | 'streaming' | 'ready' | 'applied'

function AiReply({ text, onDone }: { text: string; onDone: () => void }) {
  const { text: shown, done } = useStreamedText(text, { charsPerTick: 3, tickMs: 22 })
  const fired = useRef(false)
  useEffect(() => {
    if (done && !fired.current) {
      fired.current = true
      onDone()
    }
  }, [done, onDone])
  return (
    <p className="max-w-[92%] rounded-[20px] rounded-tl-md bg-surface-2 px-4 py-3 text-[15px] leading-relaxed">
      {shown}
      {!done && (
        <span className="ml-1 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-saffron" />
      )}
    </p>
  )
}

export function DemoStrip() {
  const [sel, setSel] = useState<Scenario | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [playKey, setPlayKey] = useState(0)

  const applied = phase === 'applied'
  const reset = () => {
    setSel(null)
    setPhase('idle')
    setPlayKey((k) => k + 1)
  }
  const pick = (s: Scenario) => {
    setSel(s)
    setPhase('streaming')
    setPlayKey((k) => k + 1)
  }

  return (
    <section
      id="demo"
      className="scroll-mt-20 py-20 [content-visibility:auto] [contain-intrinsic-size:auto_760px]"
      aria-labelledby="demo-h"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 max-w-2xl">
          <p className="mb-3 text-sm font-semibold text-accent">Try it, no signup</p>
          <h2 id="demo-h" className="text-4xl font-bold tracking-[-0.04em] sm:text-5xl">
            Say it. Watch it land on the timeline.
          </h2>
          <p className="mt-4 text-lg text-muted">
            Pick a prompt. Every change is a card you can preview, apply or undo, and the timeline
            moves the moment you say yes.
          </p>
        </div>

        <div className="glass grid gap-0 overflow-hidden rounded-[28px] lg:grid-cols-[1.1fr_1fr]">
          {/* Chat */}
          <div className="flex min-h-[28rem] flex-col gap-4 border-b border-line p-5 sm:p-7 lg:border-b-0 lg:border-r">
            <div className="flex flex-1 flex-col gap-4">
              {!sel && (
                <div className="flex flex-1 flex-col items-start justify-center gap-3">
                  <div className="flex items-center gap-3">
                    <AiMark size={34} />
                    <p className="text-[15px] text-muted">
                      Namaste! Main {AI.name} hoon. Kya karna hai is video ka?
                    </p>
                  </div>
                </div>
              )}
              {sel && (
                <>
                  <div className="flex justify-end">
                    <p className="max-w-[85%] rounded-[20px] rounded-br-md border border-saffron/25 bg-saffron-soft px-4 py-2.5 text-[15px]">
                      {sel.prompt}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <AiMark size={30} thinking={phase === 'streaming'} className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <span className="text-xs font-semibold text-muted">{AI.name}</span>
                      <AiReply
                        key={sel.id + playKey}
                        text={sel.reply}
                        onDone={() => setPhase((p) => (p === 'streaming' ? 'ready' : p))}
                      />
                      {(phase === 'ready' || phase === 'applied') && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.22 }}
                        >
                          <EditCard
                            title={sel.title}
                            description={sel.description}
                            status={applied ? 'applied' : 'proposed'}
                            strip={sel.strip}
                            summary={sel.summary}
                            onApply={() => setPhase('applied')}
                            onUndo={() => setPhase('ready')}
                            onPreview={() => undefined}
                          />
                        </motion.div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Sample prompts"
            >
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pick(s)}
                  aria-pressed={sel?.id === s.id}
                  className={
                    'rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] ' +
                    (sel?.id === s.id
                      ? 'border-saffron/60 bg-saffron-soft text-accent'
                      : 'border-line bg-surface-2 text-muted hover:border-saffron/50 hover:text-accent')
                  }
                >
                  {s.prompt}
                </button>
              ))}
              {sel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={reset}
                  leading={<RotateCcw className="size-3.5" aria-hidden="true" />}
                >
                  Start over
                </Button>
              )}
            </div>
          </div>

          {/* Result */}
          <div className="flex flex-col items-center justify-center gap-7 bg-[color-mix(in_srgb,var(--surface-2)_60%,transparent)] p-5 sm:p-7 sm:flex-row lg:flex-col xl:flex-row">
            <PhoneFrame width={172}>
              <PlaceholderThumb
                seed="demo-reel"
                aspect="reel"
                className="absolute inset-0 aspect-auto"
              >
                <p
                  lang="hi"
                  aria-hidden="true"
                  className="absolute inset-x-3 top-[58%] text-center font-deva text-[17px] font-extrabold leading-tight text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]"
                >
                  {applied || sel?.captions ? (
                    <span className="rounded-md bg-saffron px-1.5 text-saffron-ink">
                      {sel?.caption ?? ''}
                    </span>
                  ) : (
                    ''
                  )}
                </p>
              </PlaceholderThumb>
            </PhoneFrame>
            <div className="w-full min-w-0 flex-1">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold">Your timeline</p>
                {applied ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-text">
                    <Check className="size-3.5" aria-hidden="true" /> Applied
                  </span>
                ) : (
                  <span className="text-xs text-faint">
                    {sel ? 'Waiting for you' : 'Pick a prompt'}
                  </span>
                )}
              </div>
              <MiniTimeline
                segs={SEGS}
                removed={applied ? sel?.removed : undefined}
                onlyHook={applied ? sel?.onlyHook : undefined}
                captions={applied ? sel?.captions : undefined}
                playKey={playKey + (applied ? 1000 : 0)}
              />
              <p aria-live="polite" className="mt-4 text-[13px] text-muted">
                {applied
                  ? 'Done. Press Undo on the card to bring it all back. Nothing is ever lost.'
                  : 'Hatched clips are filler words and long pauses the assistant can find.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
