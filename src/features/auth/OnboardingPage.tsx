import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, Clapperboard, Link2, Mic, Scissors } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { panel } from '@/lib/motion'
import { AI } from '@/lib/config'
import { useConnectStyle } from '@/api/hooks'
import { useAuth } from '@/stores/auth'
import type { ContentType, Lang } from '@/types'

const LANGS: Array<{ id: Lang; title: string; sample: string; note: string }> = [
  {
    id: 'hinglish',
    title: 'Hinglish',
    sample: 'Funding ke baare mein baat karte hain',
    note: 'Hindi and English mixed, the way most of us talk',
  },
  {
    id: 'hi',
    title: 'हिन्दी',
    sample: 'फंडिंग के बारे में बात करते हैं',
    note: 'Mostly Hindi, shown in Devanagari',
  },
  {
    id: 'en',
    title: 'English',
    sample: "Let's talk about funding",
    note: 'English captions and chat',
  },
]

const TYPES: Array<{ id: ContentType; title: string; note: string; icon: typeof Mic }> = [
  {
    id: 'youtuber',
    title: 'YouTuber or podcaster',
    note: 'Long videos that need Shorts and Reels',
    icon: Mic,
  },
  {
    id: 'business',
    title: 'Business or brand',
    note: 'Talks, demos and customer stories',
    icon: Clapperboard,
  },
  {
    id: 'clipper',
    title: 'Clip creator',
    note: 'Turning other long videos into clips',
    icon: Scissors,
  },
]

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'relative flex w-full items-start gap-4 rounded-card border p-5 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]',
        selected
          ? 'border-saffron bg-saffron-soft'
          : 'border-line bg-surface-1 hover:border-line-strong hover:bg-surface-2',
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'ml-auto flex size-6 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-saffron bg-saffron text-saffron-ink' : 'border-line-strong',
        )}
      >
        {selected && <Check className="size-3.5" strokeWidth={3} />}
      </span>
    </button>
  )
}

/** Three short steps. Only the first two are required, and the last one has a clear Skip. */
export function OnboardingPage() {
  const user = useAuth((s) => s.user)
  const finish = useAuth((s) => s.finishOnboarding)
  const navigate = useNavigate()
  const connect = useConnectStyle()
  const [step, setStep] = useState(0)
  const [language, setLanguage] = useState<Lang>(user?.language ?? 'hinglish')
  const [contentType, setContentType] = useState<ContentType | null>(null)

  const done = async () => {
    try {
      await finish({ language, contentType })
    } catch (e) {
      toast({
        title: 'Could not save your choices',
        description: e instanceof Error ? e.message : 'Please try again.',
        tone: 'error',
      })
      return
    }
    navigate('/app', { replace: true })
  }

  const doConnect = async () => {
    try {
      await connect.mutateAsync()
    } catch {
      toast({
        title: 'Could not connect',
        description: 'You can try again later from the Style page.',
        tone: 'error',
      })
      return
    }
    toast({
      title: 'Instagram connected',
      description: `${AI.name} will learn from your recent Reels. This is a simulated connection.`,
      tone: 'success',
    })
    await done()
  }

  const titles = [
    'Which language do you edit in?',
    'What do you make?',
    `Let ${AI.name} learn your style`,
  ]

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5 py-6">
      <div className="flex items-center justify-between">
        <Logo size={28} />
        <p className="tnum text-sm text-muted" aria-live="polite">
          Step {step + 1} of 3
        </p>
      </div>
      <div className="mt-6 flex gap-1.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-200',
              i <= step ? 'bg-saffron' : 'bg-surface-3',
            )}
          />
        ))}
      </div>

      <main id="main" className="flex flex-1 flex-col justify-center py-10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={step}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            transition={panel}
            aria-labelledby="ob-h"
          >
            <h1 id="ob-h" className="text-3xl font-bold tracking-[-0.035em] sm:text-4xl">
              {titles[step]}
            </h1>

            {step === 0 && (
              <div role="radiogroup" aria-labelledby="ob-h" className="mt-8 flex flex-col gap-3">
                {LANGS.map((l) => (
                  <Choice key={l.id} selected={language === l.id} onClick={() => setLanguage(l.id)}>
                    <div>
                      <p className="text-lg font-semibold">{l.title}</p>
                      <p lang={l.id === 'en' ? 'en' : 'hi'} className="mt-1 text-[15px] text-text">
                        {l.sample}
                      </p>
                      <p className="mt-1 text-[13px] text-muted">{l.note}</p>
                    </div>
                  </Choice>
                ))}
              </div>
            )}

            {step === 1 && (
              <div role="radiogroup" aria-labelledby="ob-h" className="mt-8 flex flex-col gap-3">
                {TYPES.map((t) => (
                  <Choice
                    key={t.id}
                    selected={contentType === t.id}
                    onClick={() => setContentType(t.id)}
                  >
                    <t.icon className="mt-0.5 size-6 shrink-0 text-accent" aria-hidden="true" />
                    <div>
                      <p className="text-lg font-semibold">{t.title}</p>
                      <p className="mt-1 text-[13px] text-muted">{t.note}</p>
                    </div>
                  </Choice>
                ))}
              </div>
            )}

            {step === 2 && (
              <div className="mt-8">
                <div className="rounded-card border border-line bg-surface-1 p-6">
                  <Link2 className="size-7 text-accent" aria-hidden="true" />
                  <p className="mt-4 text-[15px] leading-relaxed text-muted">
                    Connect Instagram and {AI.name} reads how your best Reels are cut: hook timing,
                    pace, caption style. It never posts for you, and you can disconnect any time.
                  </p>
                  <p className="mt-3 text-xs text-faint">
                    Preview: this connection is simulated. Nothing leaves your browser.
                  </p>
                  <Button
                    variant="primary"
                    size="lg"
                    className="mt-6 w-full"
                    loading={connect.isPending}
                    onClick={() => void doConnect()}
                  >
                    Connect Instagram
                  </Button>
                </div>
              </div>
            )}
          </motion.section>
        </AnimatePresence>
      </main>

      <div className="flex items-center justify-between gap-3 pb-4">
        {step > 0 ? (
          <Button
            variant="ghost"
            leading={<ArrowLeft className="size-4" aria-hidden="true" />}
            onClick={() => setStep(step - 1)}
          >
            Back
          </Button>
        ) : (
          <span />
        )}
        {step < 2 ? (
          <Button
            variant="primary"
            size="lg"
            disabled={step === 1 && !contentType}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </Button>
        ) : (
          <Button variant="ghost" size="lg" onClick={done}>
            Skip for now
          </Button>
        )}
      </div>
    </div>
  )
}
