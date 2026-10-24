/**
 * Caption presets. Each one is data, so the gallery, the phone preview and the exporter all
 * read the same description. Built for Devanagari first: heavy weights, generous line height,
 * and highlights that sit behind the word instead of cutting through the matras.
 */
export type Highlight = 'none' | 'pill' | 'color' | 'underline' | 'glow'
export type Reveal = 'all' | 'word'

export interface CaptionStyle {
  id: string
  name: string
  note: string
  weight: number
  /** Font size as a percentage of the video width. */
  size: number
  fill: string
  stroke?: string
  /** CSS text-shadow. */
  shadow?: string
  highlight: Highlight
  /** Colour for the word being spoken (or already spoken, for karaoke). */
  accent: string
  /** Background of the whole caption (the "boxed" look). */
  box?: string
  upper?: boolean
  /** Reveal the whole phrase at once, or word by word. */
  reveal: Reveal
  /** Words already spoken take the accent colour (karaoke fill). */
  fillSpoken?: boolean
  position: 'lower' | 'center'
  animation: 'pop' | 'fade' | 'none'
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'saffron-pop',
    name: 'Saffron Pop',
    note: 'Bold white words, the spoken word pops in a saffron pill.',
    weight: 800,
    size: 8.4,
    fill: '#ffffff',
    shadow: '0 2px 10px rgb(0 0 0 / 0.55)',
    highlight: 'pill',
    accent: '#ffa83a',
    reveal: 'all',
    position: 'lower',
    animation: 'pop',
  },
  {
    id: 'boxed',
    name: 'Boxed',
    note: 'A calm dark box, easy to read on any footage.',
    weight: 700,
    size: 7.2,
    fill: '#ffffff',
    highlight: 'color',
    accent: '#ffa83a',
    box: 'rgb(8 10 14 / 0.78)',
    reveal: 'all',
    position: 'lower',
    animation: 'fade',
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    note: 'Words fill with teal as you say them.',
    weight: 800,
    size: 8,
    fill: 'rgb(255 255 255 / 0.92)',
    shadow: '0 2px 8px rgb(0 0 0 / 0.6)',
    highlight: 'color',
    accent: '#5fcdbb',
    fillSpoken: true,
    reveal: 'all',
    position: 'lower',
    animation: 'none',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    note: 'Small, quiet and clean. Lets the video lead.',
    weight: 600,
    size: 6.2,
    fill: '#ffffff',
    shadow: '0 1px 6px rgb(0 0 0 / 0.7)',
    highlight: 'none',
    accent: '#ffffff',
    reveal: 'all',
    position: 'lower',
    animation: 'fade',
  },
  {
    id: 'outline',
    name: 'Outline',
    note: 'Heavy black outline with a yellow spoken word. Loud and clear.',
    weight: 900,
    size: 9,
    fill: '#ffffff',
    stroke: '#000000',
    highlight: 'color',
    accent: '#ffe14a',
    upper: true,
    reveal: 'all',
    position: 'center',
    animation: 'pop',
  },
  {
    id: 'neon',
    name: 'Neon',
    note: 'A soft teal glow on the word being spoken.',
    weight: 700,
    size: 7.8,
    fill: '#eaf9f6',
    shadow: '0 0 12px rgb(95 205 187 / 0.35)',
    highlight: 'glow',
    accent: '#5fcdbb',
    reveal: 'all',
    position: 'lower',
    animation: 'fade',
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    note: 'Words appear one at a time, like they are being typed.',
    weight: 700,
    size: 7.6,
    fill: '#ffffff',
    shadow: '0 2px 8px rgb(0 0 0 / 0.6)',
    highlight: 'underline',
    accent: '#ff7a5c',
    reveal: 'word',
    position: 'lower',
    animation: 'none',
  },
  {
    id: 'coral-bounce',
    name: 'Coral Bounce',
    note: 'Playful coral pill that bounces onto each word.',
    weight: 800,
    size: 8,
    fill: '#ffffff',
    shadow: '0 2px 8px rgb(0 0 0 / 0.5)',
    highlight: 'pill',
    accent: '#ff7a5c',
    reveal: 'all',
    position: 'center',
    animation: 'pop',
  },
]

export const DEFAULT_CAPTION_STYLE = CAPTION_STYLES[0]!

export function captionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? DEFAULT_CAPTION_STYLE
}
