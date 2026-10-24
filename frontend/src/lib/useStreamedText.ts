import { useEffect, useMemo, useState } from 'react'

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** Split by grapheme so Devanagari conjuncts and vowel signs never render half-formed. */
function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)
}

/**
 * Reveals text a few characters at a time, like the assistant is typing.
 * With reduced motion on (or `enabled` false), the full text is shown at once.
 */
export function useStreamedText(
  full: string,
  { enabled = true, charsPerTick = 2, tickMs = 22 } = {},
) {
  const parts = useMemo(() => graphemes(full), [full])
  const reduce =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const instant = !enabled || reduce

  // The count is tagged with the text it belongs to, so a new message starts from zero
  // without having to reset state inside an effect.
  const [progress, setProgress] = useState({ text: full, count: 0 })
  const count = instant ? parts.length : progress.text === full ? progress.count : 0

  useEffect(() => {
    if (instant) return
    const id = setInterval(() => {
      setProgress((p) => {
        const base = p.text === full ? p.count : 0
        return { text: full, count: Math.min(parts.length, base + charsPerTick) }
      })
    }, tickMs)
    return () => clearInterval(id)
  }, [full, parts.length, instant, charsPerTick, tickMs])

  return { text: parts.slice(0, count).join(''), done: count >= parts.length }
}
