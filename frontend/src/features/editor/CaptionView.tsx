import { memo, type CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { captionAt, srcTimeAt, wordIndexAt } from '@/lib/timeline/queries'
import { usePrefs } from '@/stores/prefs'
import type { Timeline, Word } from '@/types'
import { useClock } from './clock'
import { captionStyle, type CaptionStyle } from './captionStyles'

interface PhraseProps {
  words: Word[]
  /** Index into `words` of the word being spoken, or -1. */
  active: number
  style: CaptionStyle
  dev: boolean
  font?: string
  accent?: string
  className?: string
}

/**
 * One caption phrase in a chosen style. It is a pure function of (words, active word, style),
 * so the same component draws the live phone preview and the little samples in the gallery.
 * Sizes use container units (cqw): the caption scales with the phone, never with the page.
 */
export const CaptionPhrase = memo(function CaptionPhrase({
  words,
  active,
  style,
  dev,
  font,
  accent,
  className,
}: PhraseProps) {
  const color = accent ?? style.accent
  const wrap: CSSProperties = {
    fontFamily: font ?? 'var(--font-sans), "Noto Sans Devanagari", sans-serif',
    fontWeight: style.weight,
    fontSize: `${style.size}cqw`,
    lineHeight: dev ? 1.5 : 1.25,
    color: style.fill,
    textShadow: style.shadow,
    WebkitTextStroke: style.stroke ? `${style.size * 0.09}cqw ${style.stroke}` : undefined,
    paintOrder: 'stroke fill',
    textTransform: style.upper && !dev ? 'uppercase' : undefined,
    background: style.box,
    borderRadius: style.box ? '0.6em' : undefined,
    padding: style.box ? '0.25em 0.6em' : undefined,
  }
  return (
    <p
      lang={dev ? 'hi' : 'en'}
      className={cn(
        'mx-auto flex max-w-[92%] flex-wrap justify-center gap-x-[0.28em] text-center',
        className,
      )}
      style={wrap}
    >
      {words.map((w, i) => {
        const spoken = i < active
        const on = i === active
        if (style.reveal === 'word' && i > active) return null
        const text = dev ? w.dev : w.text
        const base: CSSProperties = {}
        if (on && style.highlight === 'color') base.color = color
        if (on && style.highlight === 'glow') {
          base.color = color
          base.textShadow = `0 0 0.5em ${color}, 0 0 1.1em ${color}`
        }
        if (on && style.highlight === 'underline') base.boxShadow = `inset 0 -0.14em 0 ${color}`
        if (spoken && style.fillSpoken) base.color = color
        if (on && style.highlight === 'pill') {
          base.background = color
          base.color = '#1a1205'
          base.textShadow = 'none'
          base.WebkitTextStroke = '0'
          base.borderRadius = '0.35em'
          base.padding = '0 0.2em'
        }
        return (
          <span
            key={i}
            style={base}
            className={cn(
              'inline-block',
              on && style.animation === 'pop' && 'caption-pop',
              style.animation === 'fade' && i === 0 && 'caption-fade',
            )}
          >
            {text}
          </span>
        )
      })}
    </p>
  )
})

/** The live caption for the playhead. Re-renders only when the phrase or the spoken word changes. */
export function LiveCaption({ timeline, words }: { timeline: Timeline; words: Word[] }) {
  const dev = usePrefs((s) => s.captionDev)
  const { captionsOn, captionStyleId, captionFont, captionAccent } = timeline.settings
  const id = useClock((t) => (captionsOn ? (captionAt(timeline, t)?.id ?? '') : ''))
  const item = id ? timeline.items[id] : undefined
  const from = item?.meta?.wordFrom ?? 0
  const to = item?.meta?.wordTo ?? 0
  const active = useClock((t) => {
    if (!id) return -1
    const src = srcTimeAt(timeline, t)
    if (src === undefined) return -1
    const idx = wordIndexAt(words, src)
    return idx >= from && idx < to ? idx - from : idx >= to ? to - from : -1
  })
  if (!item) return null
  const style = captionStyle(captionStyleId)
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
      style={style.position === 'center' ? { top: '46%' } : { bottom: '22%' }}
    >
      <CaptionPhrase
        words={words.slice(from, to)}
        active={active}
        style={style}
        dev={dev}
        font={captionFont}
        accent={captionAccent}
      />
    </div>
  )
}
