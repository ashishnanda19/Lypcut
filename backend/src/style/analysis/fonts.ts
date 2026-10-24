/**
 * The font families the editor can show (`--font-sans` and `--font-deva` in frontend/src/styles/index.css; a test checks
 * they are still there). A profile only ever names one of these, so "use my font" always means something the editor has.
 */
export const EDITOR_FONTS = ['Inter', 'Noto Sans Devanagari'] as const
export type EditorFont = (typeof EDITOR_FONTS)[number]

const DEVANAGARI = /[ऀ-ॿ]/g

/**
 * The font a Reel's captions most likely used, when nothing looked at the letters themselves: captions follow the speech, so
 * speech that was written in Devanagari means Noto Sans Devanagari and anything else means Inter. A rule, not a reading.
 */
export function fontFromScript(text: string): EditorFont | null {
  const letters = text.replace(/[^\p{L}]/gu, '')
  if (letters.length < 3) return null
  const deva = text.match(DEVANAGARI)?.length ?? 0
  return deva / letters.length >= 0.3 ? 'Noto Sans Devanagari' : 'Inter'
}
