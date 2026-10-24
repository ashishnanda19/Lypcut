/**
 * The caption looks the editor offers, by id. The editor draws them; the planner only needs to know their names, so it can
 * offer them, and to refuse an id that does not exist.
 */
export interface CaptionStyleInfo {
  id: string
  name: string
  note: string
}

export const CAPTION_STYLES: CaptionStyleInfo[] = [
  {
    id: 'saffron-pop',
    name: 'Saffron Pop',
    note: 'Bold white words, the spoken word pops in a saffron pill.',
  },
  { id: 'boxed', name: 'Boxed', note: 'A calm dark box, easy to read on any footage.' },
  { id: 'karaoke', name: 'Karaoke', note: 'Words fill with teal as you say them.' },
  { id: 'minimal', name: 'Minimal', note: 'Small, quiet and clean. Lets the video lead.' },
  {
    id: 'outline',
    name: 'Outline',
    note: 'Heavy black outline with a yellow spoken word. Loud and clear.',
  },
  { id: 'neon', name: 'Neon', note: 'A soft teal glow on the word being spoken.' },
  {
    id: 'typewriter',
    name: 'Typewriter',
    note: 'Words appear one at a time, like they are being typed.',
  },
  {
    id: 'coral-bounce',
    name: 'Coral Bounce',
    note: 'Playful coral pill that bounces onto each word.',
  },
] as const

export const CAPTION_STYLE_IDS = CAPTION_STYLES.map((s) => s.id) as [string, ...string[]]
export const DEFAULT_CAPTION_STYLE = CAPTION_STYLES[0]!
export const captionStyle = (id: string): CaptionStyleInfo =>
  CAPTION_STYLES.find((s) => s.id === id) ?? DEFAULT_CAPTION_STYLE
