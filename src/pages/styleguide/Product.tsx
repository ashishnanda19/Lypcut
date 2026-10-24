import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Captions, Film, Music2, Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { ChatMessage } from '@/components/domain/ChatMessage'
import { ClipCard } from '@/components/domain/ClipCard'
import { EditCard, type EditCardStatus } from '@/components/domain/EditCard'
import { PhoneFrame } from '@/components/domain/PhoneFrame'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Playhead } from '@/components/domain/Playhead'
import { PromptBox, type PromptLanguage } from '@/components/domain/PromptBox'
import { TimelineClip } from '@/components/domain/TimelineClip'
import { TimelineRuler } from '@/components/domain/TimelineRuler'
import { TimelineTrack, TRACK_HEADER_WIDTH } from '@/components/domain/TimelineTrack'
import { TranscriptWord } from '@/components/domain/TranscriptWord'
import { useStreamedText } from '@/lib/useStreamedText'
import { Section, Stage } from './Section'

/* ---------- Chat + Edit card ---------- */

const AI_REPLY =
  'Pakad liya! Mujhe 3 filler words aur ek lamba pause mila. Inhe hata doon? Total 4 seconds bachenge.'

function ChatDemo() {
  const [status, setStatus] = useState<EditCardStatus>('proposed')
  const [lang, setLang] = useState<PromptLanguage>('hinglish')
  const [sent, setSent] = useState<string[]>([])
  const { text, done } = useStreamedText(AI_REPLY)

  return (
    <div className="flex flex-col gap-5 rounded-panel border border-line bg-surface-1 p-5">
      <ChatMessage from="user" text="Filler words aur lambe pause hata do" />
      <ChatMessage from="ai" text={text} streaming={!done}>
        {done && (
          <EditCard
            title="Remove 3 fillers and 1 long pause"
            description="Cuts “matlab”, “basically”, “um” and a 2.4s pause between 1:12 and 1:40."
            status={status}
            strip={[
              { kind: 'keep', weight: 6 },
              { kind: 'cut', weight: 1 },
              { kind: 'keep', weight: 9 },
              { kind: 'cut', weight: 2 },
              { kind: 'keep', weight: 5 },
              { kind: 'cut', weight: 1 },
              { kind: 'keep', weight: 7 },
            ]}
            summary={[
              { label: 'Cuts', value: '4', tone: 'coral' },
              { label: 'Saved', value: '0:04', tone: 'teal' },
            ]}
            onPreview={() => setStatus((s) => (s === 'previewing' ? 'proposed' : 'previewing'))}
            onApply={() => setStatus('applied')}
            onUndo={() => setStatus('undone')}
          />
        )}
      </ChatMessage>
      {sent.map((m, i) => (
        <ChatMessage key={i} from="user" text={m} />
      ))}
      <PromptBox
        language={lang}
        onLanguageChange={setLang}
        onSubmit={(t) => setSent((s) => [...s, t])}
        suggestions={[
          'Find my best hook',
          'Make this a 30 second Reel',
          'Add captions',
          'Blur the background',
        ]}
      />
    </div>
  )
}

/* ---------- Transcript ---------- */

interface DemoWord {
  dev: string
  rom: string
  filler?: boolean
}

const WORDS: DemoWord[] = [
  { dev: 'तो', rom: 'toh' },
  { dev: 'बेसिकली', rom: 'basically', filler: true },
  { dev: 'आज', rom: 'aaj' },
  { dev: 'हम', rom: 'hum' },
  { dev: 'बात', rom: 'baat' },
  { dev: 'करेंगे', rom: 'karenge' },
  { dev: 'कि', rom: 'ki' },
  { dev: 'फंडिंग', rom: 'funding' },
  { dev: 'कैसे', rom: 'kaise' },
  { dev: 'रेज़', rom: 'raise' },
  { dev: 'करते', rom: 'karte' },
  { dev: 'हैं,', rom: 'hain,' },
  { dev: 'मतलब', rom: 'matlab', filler: true },
  { dev: 'पहले', rom: 'pehle' },
  { dev: 'क्या', rom: 'kya' },
  { dev: 'करना', rom: 'karna' },
  { dev: 'चाहिए।', rom: 'chahiye.' },
]

function TranscriptDemo() {
  const [script, setScript] = useState<'dev' | 'rom'>('rom')
  const [current, setCurrent] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [cut, setCut] = useState<Set<number>>(new Set())

  const toggleCut = useCallback((i: number) => {
    setCut((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }, [])

  // The real editor drives this from one shared playback clock; this is a stand-in.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(
      () => setCurrent((c) => (c + 1 >= WORDS.length ? (setPlaying(false), -1) : c + 1)),
      420,
    )
    return () => clearInterval(id)
  }, [playing])

  // One delegated handler for every word.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')
    if (!el) return
    const i = Number(el.dataset.i)
    if (e.altKey || cut.has(i)) toggleCut(i)
    else setCurrent(i)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') setCurrent((c) => Math.min(WORDS.length - 1, c + 1))
    else if (e.key === 'ArrowLeft') setCurrent((c) => Math.max(0, c - 1))
    else if ((e.key === 'Delete' || e.key === 'Backspace') && current >= 0) {
      e.preventDefault()
      toggleCut(current)
    }
  }

  const removeFillers = () => setCut(new Set(WORDS.flatMap((w, i) => (w.filler ? [i] : []))))

  return (
    <div className="rounded-panel border border-line bg-surface-1 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={script} onValueChange={(v) => setScript(v as 'dev' | 'rom')}>
          <TabsList label="Transcript script" className="w-56">
            <TabsTrigger value="rom">Roman</TabsTrigger>
            <TabsTrigger value="dev">देवनागरी</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Button size="sm" variant="teal" onClick={removeFillers}>
            Remove fillers
          </Button>
          <Button size="sm" onClick={() => setCut(new Set())} disabled={cut.size === 0}>
            Restore all
          </Button>
          <Button
            size="sm"
            variant="primary"
            leading={
              playing ? (
                <Pause className="size-3.5" aria-hidden="true" />
              ) : (
                <Play className="size-3.5" aria-hidden="true" />
              )
            }
            onClick={() => {
              if (current < 0 || current >= WORDS.length - 1) setCurrent(0)
              setPlaying((p) => !p)
            }}
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
        </div>
      </div>

      <p className="mb-2 text-xs font-semibold text-faint">Speaker 1</p>
      {/* A real transcript gets a fuller keyboard model in step 6. */}
      <div
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label="Transcript. Arrow keys move between words, Delete cuts the current word."
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        lang={script === 'dev' ? 'hi' : undefined}
        className="rounded-control text-[19px] leading-[2.1] text-text"
      >
        {WORDS.map((w, i) => (
          <span key={i}>
            <TranscriptWord
              index={i}
              text={script === 'dev' ? w.dev : w.rom}
              current={i === current}
              cut={cut.has(i)}
              filler={w.filler}
            />{' '}
          </span>
        ))}
      </div>
      <p className="mt-4 text-[13px] text-faint">
        Click a word to jump there. Click a struck-out word to restore it. With the transcript
        focused, arrow keys move and Delete cuts.
      </p>
    </div>
  )
}

/* ---------- Timeline ---------- */

const PX_PER_SEC = 28
const DURATION = 40
const LANE = DURATION * PX_PER_SEC

function TimelineDemo() {
  const [landKey, setLandKey] = useState(0)
  const [time, setTime] = useState(9.4)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => setTime((t) => (t >= DURATION ? 0 : t + 0.1)), 100)
    return () => clearInterval(id)
  }, [playing])

  const replay = () => setLandKey((k) => k + 1)

  return (
    <div className="rounded-panel border border-line bg-surface-1 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          leading={
            playing ? (
              <Pause className="size-3.5" aria-hidden="true" />
            ) : (
              <Play className="size-3.5" aria-hidden="true" />
            )
          }
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          leading={<RotateCcw className="size-3.5" aria-hidden="true" />}
          onClick={replay}
        >
          Replay an AI edit
        </Button>
        <span className="text-[13px] text-faint">
          The clip arcs in, lands with a squash, and glows once.
        </span>
      </div>

      <div className="scroll-thin overflow-x-auto rounded-card border border-line">
        <div
          role="grid"
          aria-label="Timeline"
          className="relative"
          style={{ width: LANE + TRACK_HEADER_WIDTH }}
        >
          <div
            className="pointer-events-none absolute inset-y-0 z-30"
            style={{ left: TRACK_HEADER_WIDTH, right: 0 }}
          >
            <Playhead x={time * PX_PER_SEC} time={time} />
          </div>

          <TimelineRuler duration={DURATION} pxPerSecond={PX_PER_SEC} />
          <TimelineTrack
            label="Video"
            icon={<Film className="size-3.5" />}
            laneWidth={LANE}
            height={56}
          >
            <TimelineClip kind="video" label="Intro" left={0} width={7 * PX_PER_SEC} height={48} />
            <TimelineClip
              key={`v2-${landKey}`}
              kind="video"
              label="Funding, the real story"
              left={7.4 * PX_PER_SEC}
              width={15 * PX_PER_SEC}
              height={48}
              selected
              landed={landKey > 0 ? 'leap' : undefined}
              cutAt={landKey > 0 ? 4 * PX_PER_SEC : undefined}
            />
            <TimelineClip
              kind="video"
              label="Q and A"
              left={23.2 * PX_PER_SEC}
              width={16 * PX_PER_SEC}
              height={48}
            />
          </TimelineTrack>
          <TimelineTrack
            label="B-roll"
            icon={<Film className="size-3.5" />}
            laneWidth={LANE}
            height={44}
          >
            <TimelineClip
              key={`b-${landKey}`}
              kind="broll"
              label="Office shot"
              left={11 * PX_PER_SEC}
              width={5 * PX_PER_SEC}
              height={36}
              landed={landKey > 0 ? 'slide' : undefined}
            />
          </TimelineTrack>
          <TimelineTrack
            label="Audio"
            icon={<Music2 className="size-3.5" />}
            laneWidth={LANE}
            height={48}
            onToggleMute={() => {}}
          >
            <TimelineClip kind="audio" label="Voice" left={0} width={LANE - 4} height={40} />
          </TimelineTrack>
          <TimelineTrack
            label="Captions"
            icon={<Captions className="size-3.5" />}
            laneWidth={LANE}
            height={44}
          >
            {[
              'Toh basically',
              'aaj funding',
              'kaise raise',
              'karte hain',
              'matlab pehle',
              'kya karna',
            ].map((c, i) => (
              <TimelineClip
                key={c}
                kind="caption"
                label={c}
                left={(1 + i * 6.1) * PX_PER_SEC}
                width={5.6 * PX_PER_SEC}
                height={34}
              />
            ))}
          </TimelineTrack>
        </div>
      </div>
    </div>
  )
}

/* ---------- Phone preview ---------- */

function PhoneDemo() {
  const [safe, setSafe] = useState(true)
  return (
    <Stage className="items-start gap-8">
      <PhoneFrame width={230} safeZones={safe}>
        <PlaceholderThumb seed="reel-demo" aspect="reel" className="absolute inset-0 aspect-auto">
          <p
            lang="hi"
            className="absolute left-4 right-[18%] top-[50%] text-center text-[22px] font-extrabold leading-tight text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.7)]"
          >
            <span className="rounded-md bg-saffron px-1.5 text-saffron-ink">फंडिंग</span> कैसे रेज़
            करें
          </p>
        </PlaceholderThumb>
      </PhoneFrame>
      <div className="max-w-xs space-y-3">
        <p className="text-sm text-muted">
          The preview shows the true 9:16 result. Safe zones mark where app controls will cover the
          video, so captions never land under a button.
        </p>
        <Button
          size="sm"
          variant={safe ? 'teal' : 'secondary'}
          aria-pressed={safe}
          onClick={() => setSafe((s) => !s)}
        >
          {safe ? 'Hide safe zones' : 'Show safe zones'}
        </Button>
      </div>
    </Stage>
  )
}

export function Product() {
  return (
    <>
      <Section
        id="chat"
        title="Chat and Edit cards"
        description="Conversation is the centre of the editor. Every AI action arrives as an Edit card you can preview, apply and undo."
      >
        <div className="max-w-2xl">
          <ChatDemo />
        </div>
      </Section>

      <Section
        id="transcript"
        title="Transcript"
        description="Words are the handle for the video. Fillers are underlined in teal, cut words are struck through in coral."
      >
        <TranscriptDemo />
      </Section>

      <Section
        id="timeline"
        title="Timeline"
        description="Clips are plain positioned blocks, and the playhead moves with a transform, so hundreds of them stay smooth."
      >
        <TimelineDemo />
      </Section>

      <Section
        id="reel"
        title="Phone preview"
        description="The Live Reel preview always matches the export."
      >
        <PhoneDemo />
      </Section>

      <Section
        id="cards"
        title="Clip cards"
        description="One card for AI highlights and search results. The ring is the hook score."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ClipCard
            seed="hook-1"
            title="The ₹40 lakh mistake"
            start={72}
            end={109}
            score={92}
            reason="Opens with a surprising number, then pays it off in 8 seconds."
          />
          <ClipCard
            seed="search-1"
            title="Funding, the real story"
            start={312}
            end={344}
            score={87}
            scoreLabel="Relevance"
            matched={
              <>
                matlab sabse pehle <mark>funding</mark> kaise raise karte hain, wo samajhna padega
              </>
            }
          />
          <ClipCard
            seed="hook-3"
            title="Why I said no to the investor"
            start={601}
            end={640}
            score={64}
            reason="Strong opinion, slower start."
          />
        </div>
      </Section>
    </>
  )
}
