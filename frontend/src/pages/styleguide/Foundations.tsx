import { useState } from 'react'
import { AiMark } from '@/components/brand/AiMark'
import { CutLine } from '@/components/brand/CutLine'
import { LeapLoader } from '@/components/brand/LeapLoader'
import { Logo, LogoMark } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { AI } from '@/lib/config'
import { formatTimecode } from '@/lib/time'
import { Section, Stage } from './Section'

const swatches = [
  { name: 'Ink', token: '--bg', use: 'App background' },
  { name: 'Panel', token: '--surface-1', use: 'Panels and cards' },
  { name: 'Raised', token: '--surface-2', use: 'Inputs, chips, bubbles' },
  { name: 'Hover', token: '--surface-3', use: 'Hover and selected' },
  { name: 'Saffron', token: '--saffron', use: 'Primary action, playhead, current word' },
  { name: 'Teal', token: '--teal', use: 'Secondary, success, safe zones' },
  { name: 'Coral', token: '--coral', use: 'The cut-line only' },
  { name: 'Text', token: '--text', use: 'Primary text' },
]

export function Foundations() {
  const [flash, setFlash] = useState(0)
  return (
    <>
      <Section
        id="brand"
        title="Brand"
        description="A clip leaps over a cut-line. That one gesture is the logo, the loader, the empty states and the way every AI edit lands on the timeline."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Stage title="Logo" className="gap-8">
            <Logo size={44} animated />
            <Logo size={28} />
            <LogoMark size={36} />
          </Stage>
          <Stage title={`${AI.name} (${AI.nameDevanagari}), the assistant`} className="gap-8">
            <AiMark size={44} />
            <AiMark size={44} thinking />
            <AiMark size={28} />
            <span className="text-sm text-muted">Idle, thinking, small</span>
          </Stage>
          <Stage title="Loader">
            <LeapLoader />
            <span className="text-sm text-muted">Used for page loads and processing</span>
          </Stage>
          <Stage title="Cut-line">
            <div className="flex h-16 items-center gap-6">
              <div className="h-full">
                <CutLine flash={flash > 0} flashKey={flash} />
              </div>
              <div className="w-40">
                <CutLine orientation="horizontal" />
              </div>
              <Button size="sm" onClick={() => setFlash((n) => n + 1)}>
                Flash a cut
              </Button>
            </div>
          </Stage>
        </div>
      </Section>

      <Section
        id="color"
        title="Colour"
        description="Deep ink, warm saffron, soft teal. Coral is kept for the cut-line so it always means 'something was cut here'."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {swatches.map((s) => (
            <div
              key={s.token}
              className="overflow-hidden rounded-card border border-line bg-surface-1"
            >
              <div
                className="h-16 border-b border-line"
                style={{ background: `var(${s.token})` }}
              />
              <div className="p-3">
                <p className="text-sm font-semibold">{s.name}</p>
                <p className="mt-0.5 text-xs text-muted">{s.use}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="type"
        title="Type"
        description="Inter for the interface, Noto Sans Devanagari for Hindi. Timecodes use tabular numbers so they never jitter during playback."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Stage title="Display and headings" className="flex-col items-start gap-4">
            <p className="text-balance text-5xl font-bold leading-[1.05] tracking-[-0.04em]">
              Edit your video by talking to it.
            </p>
            <p className="text-2xl font-semibold tracking-tight">Tell it what to cut</p>
            <p className="max-w-prose text-[15px] text-muted">
              Upload a long video, tell the assistant what you want, and watch each change land on
              the timeline the moment it happens.
            </p>
          </Stage>
          <Stage title="Hindi, Hinglish and English" className="flex-col items-start gap-4">
            <p className="text-lg">Find the part where I talk about funding.</p>
            <p className="text-lg">
              Funding wala hissa dhoondo aur usse 30 second ki Reel bana do.
            </p>
            <p lang="hi" className="text-lg">
              जहाँ मैं फंडिंग के बारे में बात करता हूँ, वह हिस्सा ढूँढो।
            </p>
            <div className="tnum rounded-control bg-surface-2 px-4 py-3 font-medium">
              {[0, 11.1, 88.8, 124.4].map((t) => (
                <p key={t}>{formatTimecode(t)}</p>
              ))}
            </div>
          </Stage>
        </div>
      </Section>
    </>
  )
}
