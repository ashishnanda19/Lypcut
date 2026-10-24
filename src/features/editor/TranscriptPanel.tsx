import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Eraser, RotateCcw, Scissors, Smartphone, Wand2 } from 'lucide-react'
import { TranscriptWord } from '@/components/domain/TranscriptWord'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import { cutFlags, srcTimeAt, timeAtSource, wordIndexAt } from '@/lib/timeline/queries'
import { cutWords, fillerIndices, removeFillersOp, restoreWords } from '@/lib/timeline/transcript'
import { usePrefs } from '@/stores/prefs'
import type { Sentence, Speaker, Word } from '@/types'
import { clock, useClock } from './clock'
import { useEditorData } from './data'
import { commitYou } from './timelineActions'
import { headTimeline, shownTimeline, useEditor } from './store'

interface RowProps {
  sentence: Sentence
  words: Word[]
  flags: Uint8Array
  speaker: Speaker | undefined
  current: number
  selFrom: number
  selTo: number
  dev: boolean
  onSeekTime: (srcT: number) => void
}

/**
 * One sentence of the transcript. `current` is -1 for every row except the one being spoken, and
 * selection bounds are -1 for rows with no selection, so during playback only one row re-renders.
 */
const Row = memo(function Row({
  sentence,
  words,
  flags,
  speaker,
  current,
  selFrom,
  selTo,
  dev,
  onSeekTime,
}: RowProps) {
  const out = []
  for (let i = sentence.from; i < sentence.to; i++) {
    const w = words[i]!
    out.push(
      <TranscriptWord
        key={i}
        index={i}
        text={dev ? w.dev : w.text}
        current={i === current}
        cut={flags[i] === 1}
        selected={i >= selFrom && i <= selTo}
        filler={w.filler}
      />,
    )
  }
  return (
    <div className="flex gap-3 border-b border-line/60 px-3 py-3">
      <div className="w-[4.6rem] shrink-0 pt-0.5">
        <span
          className={cn(
            'block truncate text-[11px] font-semibold',
            speaker?.color === 'teal' ? 'text-teal-text' : 'text-accent',
          )}
        >
          {speaker?.name.split(' ')[0] ?? '?'}
        </span>
        <button
          type="button"
          onClick={() => onSeekTime(sentence.start)}
          className="tnum mt-0.5 rounded text-[11px] text-faint hover:text-text"
          aria-label={`Go to ${formatDuration(sentence.start)}`}
        >
          {formatDuration(sentence.start)}
        </button>
      </div>
      <p
        lang={dev ? 'hi' : undefined}
        className={cn(
          'min-w-0 flex-1 text-[15px] [word-spacing:1px]',
          dev ? 'leading-[2.1]' : 'leading-[1.9]',
        )}
      >
        {out}
      </p>
    </div>
  )
})

export function TranscriptPanel() {
  const { transcript } = useEditorData()
  const tl = useEditor(shownTimeline)
  const dev = usePrefs((s) => s.devanagari)
  const setDev = usePrefs((s) => s.setDevanagari)
  const readOnly = useEditor((s) => !!s.preview)
  const askChat = useEditor((s) => s.askChat)
  const { words, sentences, speakers } = transcript

  const flags = useMemo(() => cutFlags(tl, words), [tl, words])
  const fillers = useMemo(() => fillerIndices(tl, words).length, [tl, words])

  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  const lo = sel ? Math.min(sel.a, sel.b) : -1
  const hi = sel ? Math.max(sel.a, sel.b) : -1

  /* ---- the word being spoken ---- */
  const current = useClock((t) => {
    const src = srcTimeAt(tl, t)
    return src === undefined ? -1 : wordIndexAt(words, src)
  })
  const currentRow = useMemo(() => {
    if (current < 0) return -1
    let l = 0
    let r = sentences.length - 1
    while (l < r) {
      const m = (l + r) >> 1
      if (sentences[m]!.to <= current) l = m + 1
      else r = m
    }
    return l
  }, [current, sentences])

  /* ---- windowed list: thousands of words cost nothing off screen ---- */
  const scroller = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is used as documented
  const virt = useVirtualizer({
    count: sentences.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => 56 + Math.ceil((sentences[i]!.to - sentences[i]!.from) / 7) * 30,
    overscan: 8,
  })

  // Follow playback, unless the person has scrolled away on purpose.
  const userScrolledAt = useRef(0)
  const playing = useClock((_, p) => p)
  useEffect(() => {
    if (!playing || currentRow < 0) return
    if (Date.now() - userScrolledAt.current < 4000) return
    virt.scrollToIndex(currentRow, { align: 'center', behavior: 'auto' })
  }, [playing, currentRow, virt])

  const seekToSource = useCallback(
    (srcT: number) => {
      const t = timeAtSource(tl, srcT)
      if (t === undefined) {
        toast({
          title: 'That part is cut',
          description: 'Select it and press Restore to bring it back.',
          tone: 'info',
        })
        return
      }
      clock.seek(t)
    },
    [tl],
  )

  /* ---- selecting words: click, drag, shift+click ---- */
  const anchor = useRef<number | null>(null)
  const moved = useRef(false)
  const indexAt = (el: EventTarget | null): number | null => {
    const n = (el as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null
    return n ? Number(n.dataset.i) : null
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    const i = indexAt(e.target)
    if (i === null) return
    scroller.current?.focus({ preventScroll: true })
    moved.current = false
    if (e.shiftKey && sel) {
      setSel({ a: sel.a, b: i })
      anchor.current = null
      return
    }
    anchor.current = i
    setSel({ a: i, b: i })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (anchor.current === null || e.buttons !== 1) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const i = indexAt(el)
    if (i !== null && i !== sel?.b) {
      moved.current = true
      setSel({ a: anchor.current, b: i })
    }
  }
  const onUp = () => {
    if (anchor.current !== null && !moved.current) {
      const w = words[anchor.current]!
      if (flags[anchor.current] !== 1) seekToSource(w.start)
    }
    anchor.current = null
  }

  /* ---- actions ---- */
  const allCut =
    lo >= 0 && Array.from({ length: hi - lo + 1 }, (_, k) => flags[lo + k] === 1).every(Boolean)
  const phrase =
    lo >= 0
      ? words
          .slice(lo, Math.min(hi + 1, lo + 4))
          .map((w) => w.text)
          .join(' ') + (hi - lo >= 4 ? '…' : '')
      : ''

  const doDelete = () => {
    if (lo < 0 || readOnly) return
    if (commitYou(cutWords(words, lo, hi), `Deleted “${phrase}”`)) {
      setSel(null)
    }
  }
  const doRestore = () => {
    if (lo < 0 || readOnly) return
    if (
      commitYou(
        restoreWords(headTimeline(useEditor.getState()), words, lo, hi),
        `Restored “${phrase}”`,
      )
    )
      setSel(null)
  }
  const doFillers = () => {
    const r = removeFillersOp(headTimeline(useEditor.getState()), words)
    if (!r) return
    commitYou(r.op, `Removed ${r.count} filler words`)
  }
  const doReel = () => {
    if (lo < 0) return
    const from = words[lo]!.start
    const to = words[Math.min(hi + 1, words.length - 1)]!.start
    askChat({
      text: `Make a Reel from “${phrase}”`,
      reel: { srcFrom: from, srcTo: Math.max(to, from + 5), title: phrase },
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (lo < 0) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      if (allCut) doRestore()
      else doDelete()
    } else if (e.key === 'Escape') {
      setSel(null)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const d = e.key === 'ArrowRight' ? 1 : -1
      const b = Math.max(0, Math.min(words.length - 1, (sel?.b ?? 0) + d))
      setSel(e.shiftKey ? { a: sel!.a, b } : { a: b, b })
      virt.scrollToIndex(
        sentences.findIndex((s) => b >= s.from && b < s.to),
        { align: 'auto' },
      )
    }
  }

  if (!sentences.length) {
    return (
      <EmptyState
        title="No speech found"
        description="We could not hear anyone talking in this video."
        size="sm"
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
        <div
          role="radiogroup"
          aria-label="Transcript script"
          className="flex rounded-full bg-surface-2 p-0.5"
        >
          {[
            [false, 'Roman'],
            [true, 'देवनागरी'],
          ].map(([v, label]) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={dev === v}
              onClick={() => setDev(v as boolean)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                dev === v ? 'bg-surface-1 text-text shadow-soft' : 'text-muted hover:text-text',
              )}
            >
              {label as string}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="teal"
          className="ml-auto"
          disabled={!fillers || readOnly}
          leading={<Wand2 className="size-3.5" aria-hidden="true" />}
          onClick={doFillers}
        >
          {fillers ? `Remove ${fillers} fillers` : 'No fillers left'}
        </Button>
      </div>

      {lo >= 0 && (
        <div
          role="toolbar"
          aria-label="Selected words"
          className="mb-2 flex flex-wrap items-center gap-1.5 rounded-card border border-line bg-surface-2 p-2"
        >
          <span className="tnum px-2 text-xs text-muted">
            {hi - lo + 1} word{hi > lo ? 's' : ''}
          </span>
          {allCut ? (
            <Button
              size="sm"
              variant="primary"
              leading={<RotateCcw className="size-3.5" aria-hidden="true" />}
              onClick={doRestore}
              disabled={readOnly}
            >
              Restore
            </Button>
          ) : (
            <Button
              size="sm"
              variant="danger"
              leading={<Scissors className="size-3.5" aria-hidden="true" />}
              onClick={doDelete}
              disabled={readOnly}
            >
              Cut
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            leading={<Smartphone className="size-3.5" aria-hidden="true" />}
            onClick={doReel}
          >
            Make a Reel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            leading={<Eraser className="size-3.5" aria-hidden="true" />}
            onClick={() => setSel(null)}
          >
            Clear
          </Button>
        </div>
      )}

      {/* The transcript is a keyboard-operable selection surface, so it takes keys and pointer input. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={scroller}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="document"
        aria-label="Transcript. Select words, then press Delete to cut them."
        onKeyDown={onKeyDown}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={() => (userScrolledAt.current = Date.now())}
        onTouchMove={() => (userScrolledAt.current = Date.now())}
        className="scroll-thin min-h-0 flex-1 select-none overflow-y-auto rounded-card border border-line bg-surface-1 outline-offset-[-2px]"
      >
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const s = sentences[v.index]!
            const has = lo >= 0 && hi >= s.from && lo < s.to
            return (
              <div
                key={s.id}
                data-index={v.index}
                ref={virt.measureElement}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <Row
                  sentence={s}
                  words={words}
                  flags={flags}
                  speaker={speakers.find((x) => x.id === s.speaker)}
                  current={v.index === currentRow ? current : -1}
                  selFrom={has ? lo : -1}
                  selTo={has ? hi : -2}
                  dev={dev}
                  onSeekTime={seekToSource}
                />
              </div>
            )
          })}
        </div>
      </div>
      <p className="px-1 pt-2 text-xs text-faint">
        Click a word to jump there. Drag across words, then press Delete to cut them. Struck-out
        words are cut, and you can restore them.
      </p>
    </div>
  )
}
