import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACCENTS, readCaptions, RULES, type Frame } from '../../src/style/analysis/captions.js'
import { EDITOR_FONTS, fontFromScript } from '../../src/style/analysis/fonts.js'
import { CAPTION_STYLE_IDS } from '../../src/planner/caption-styles.js'
import { footage, looks, noCaptions, plainWhite, rect, text } from '../helpers/frames.js'

/** Six frames of a Reel: the look shows in four, and in two the speaker is not talking. */
const reel = (make: () => Frame, shown = 4): Frame[] =>
  Array.from({ length: 6 }, (_, i) => (i < shown ? make() : noCaptions()))

describe('reading a Reel’s caption look from its frames', () => {
  for (const [id, make] of Object.entries(looks)) {
    it(`recognises ${id}`, () => {
      const read = readCaptions(reel(make))
      expect(read.status, JSON.stringify(read)).toBe('matched')
      expect(read.styleId).toBe(id)
    })
  }

  it('has a rule for every look it claims, and each is a look the editor has', () => {
    expect(Object.keys(RULES).sort()).toEqual(Object.keys(looks).sort())
    for (const id of Object.keys(RULES)) expect(CAPTION_STYLE_IDS).toContain(id)
  })

  it('says there are no captions when no frame has any', () => {
    expect(readCaptions(reel(noCaptions)).status).toBe('none')
    expect(readCaptions(reel(plainWhite, 1)).status).toBe('none')
  })

  it('does not guess for plain white text: it fits no look in particular', () => {
    const read = readCaptions(reel(plainWhite))
    expect(read.status).toBe('ambiguous')
    expect(read.styleId).toBeNull()
  })

  it('does not take a dark background for a box, or a teal object for karaoke', () => {
    const dark = () => {
      const f = footage()
      rect(f, 0, 270, 270, 180, [10, 12, 16])
      return text(f, 60, 360)
    }
    expect(readCaptions(reel(dark)).styleId).toBeNull()
    const teal = () => {
      const f = footage()
      rect(f, 100, 330, 80, 70, '#5fcdbb')
      return f
    }
    expect(readCaptions(reel(teal)).status).toBe('none')
  })

  it('is not matched by a look seen in one frame only', () => {
    expect(readCaptions(reel(looks['saffron-pop'], 1)).styleId).toBeNull()
  })

  it('does not choose between two looks that each fill most frames', () => {
    const both = (i: number) => (i % 2 ? looks['saffron-pop']() : looks.boxed())
    const frames = Array.from({ length: 6 }, (_, i) => both(i))
    const read = readCaptions(frames)
    expect(read.status).toBe('ambiguous')
    if (read.status === 'ambiguous')
      expect(read.candidates.sort()).toEqual(['boxed', 'saffron-pop'])
  })

  it('names the colours that were really in the captions', () => {
    const read = readCaptions(reel(looks['saffron-pop']))
    expect(read.colors[0]).toBe('#ffa83a')
    expect(read.colors).toContain('#ffffff')
    expect(readCaptions(reel(looks.outline)).colors[0]).toBe('#ffe14a')
  })

  it('treats what is in a frame as pixels: nothing in one changes which looks exist', () => {
    // Frames with caption-like content cannot add a look, rename one or return anything but a known id.
    for (const make of Object.values(looks)) {
      const read = readCaptions(reel(make))
      if (read.styleId) expect(CAPTION_STYLE_IDS).toContain(read.styleId)
    }
  })
})

describe('fonts', () => {
  it('names only the editor’s families, by the script of the speech', () => {
    expect(fontFromScript('आज हम बात करेंगे फंडिंग के बारे में')).toBe('Noto Sans Devanagari')
    expect(fontFromScript('aaj hum baat karenge funding ke baare mein')).toBe('Inter')
    expect(fontFromScript('so today we talk about funding')).toBe('Inter')
    expect(fontFromScript('')).toBeNull()
    expect(fontFromScript('hi')).toBeNull()
    for (const f of [fontFromScript('आज'), fontFromScript('hello there')])
      if (f) expect(EDITOR_FONTS).toContain(f)
  })
})

describe('staying in step with the editor', () => {
  const root = path.resolve(import.meta.dirname, '../../../frontend/src')
  const styles = path.join(root, 'features/editor/captionStyles.ts')
  const css = path.join(root, 'styles/index.css')
  const present = existsSync(styles) && existsSync(css)

  it.skipIf(!present)(
    'the accent colours and the looks match frontend/src/features/editor/captionStyles.ts',
    () => {
      const source = readFileSync(styles, 'utf8')
      const blocks = source.split(/\n\s*\{\s*\n\s*id: '/).slice(1)
      const accentOf = Object.fromEntries(
        blocks.map((b) => [b.slice(0, b.indexOf("'")), /accent: '(#[0-9a-f]{6})'/i.exec(b)?.[1]]),
      )
      expect(Object.keys(accentOf).sort()).toEqual([...CAPTION_STYLE_IDS].sort())
      expect(accentOf['saffron-pop']).toBe(ACCENTS.saffron)
      expect(accentOf.boxed).toBe(ACCENTS.saffron)
      expect(accentOf.outline).toBe(ACCENTS.yellow)
      expect(accentOf.karaoke).toBe(ACCENTS.teal)
      expect(accentOf.neon).toBe(ACCENTS.teal)
      expect(accentOf['coral-bounce']).toBe(ACCENTS.coral)
      expect(accentOf.typewriter).toBe(ACCENTS.coral)
    },
  )

  it.skipIf(!present)('the font families are the ones the editor loads', () => {
    const sheet = readFileSync(css, 'utf8')
    for (const family of EDITOR_FONTS) expect(sheet).toContain(family)
  })
})
