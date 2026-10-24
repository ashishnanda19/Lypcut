import { describe, expect, it } from 'vitest'
import {
  ENGLISH_LOANWORDS,
  HINDI_WORDS,
  isEnglishDevanagari,
  isFillerWord,
  isHindiRoman,
  knownDevanagari,
  knownRoman,
} from '../../src/transcription/lexicon.js'
import {
  devanagariToRoman,
  hasDevanagari,
  hasLatin,
  romanToDevanagari,
} from '../../src/transcription/translit.js'

describe('lexicon', () => {
  it('every Roman spelling is lower-case letters and every Devanagari one is Devanagari', () => {
    for (const [roman, dev] of [...HINDI_WORDS, ...ENGLISH_LOANWORDS]) {
      expect(roman, roman).toMatch(/^[a-z]+$/)
      // Devanagari, with a hyphen allowed for compounds such as को-फाउंडर.
      expect(dev, dev).toMatch(/^[ऀ-ॿ-]+$/)
    }
  })

  it('looks words up in both directions', () => {
    expect(knownRoman('फंडिंग')).toBe('funding')
    expect(knownRoman('नहीं')).toBe('nahi')
    expect(knownDevanagari('kaise')).toBe('कैसे')
    expect(knownDevanagari('Funding,')).toBe('फंडिंग')
    expect(knownRoman('अज्ञातशब्द')).toBeUndefined()
  })

  it('tells English from Hindi', () => {
    expect(isEnglishDevanagari('फंडिंग')).toBe(true)
    expect(isEnglishDevanagari('बहुत')).toBe(false)
    expect(isHindiRoman('kaise')).toBe(true)
    expect(isHindiRoman('funding')).toBe(false)
    // "raise" is English even though Hindi speakers use it constantly.
    expect(isHindiRoman('raise')).toBe(false)
  })

  it('knows the fillers', () => {
    for (const f of ['um', 'UH', 'Matlab', 'basically,']) expect(isFillerWord(f), f).toBe(true)
    for (const w of ['umbrella', 'baat', 'ham']) expect(isFillerWord(w), w).toBe(false)
  })
})

describe('Devanagari to Roman by rules', () => {
  const cases: Array<[string, string]> = [
    ['कैसे', 'kaise'],
    ['मुझे', 'mujhe'],
    ['समझना', 'samajhna'], // the inherent 'a' inside the word is dropped
    ['कमल', 'kamal'], // and the one at the end
    ['किताब', 'kitab'],
    ['सरकार', 'sarkar'],
    ['प्रेम', 'prem'], // a conjunct
    ['पुस्तक', 'pustak'],
    ['दोस्तों', 'doston'],
    ['बच्चों', 'bachchon'],
    ['मुश्किल', 'mushkil'],
    ['पढ़ाई', 'padhai'],
    ['लड़की', 'larki'],
    ['ख़ुशी', 'khushi'],
    ['ज़िम्मेदारी', 'zimmedari'],
    ['हिंदुस्तान', 'hindustan'], // anusvara
    ['आत्मविश्वास', 'aatmavishvas'],
  ]
  for (const [dev, roman] of cases) {
    it(`${dev} -> ${roman}`, () => expect(devanagariToRoman(dev)).toBe(roman))
  }

  it('prefers the lexicon: फंडिंग is "funding", not "phanding"', () => {
    expect(devanagariToRoman('फंडिंग')).toBe('funding')
    expect(devanagariToRoman('नहीं')).toBe('nahi')
  })

  it('turns Devanagari digits into digits and the danda into a full stop', () => {
    expect(devanagariToRoman('४०')).toBe('40')
    expect(devanagariToRoman('।')).toBe('.')
  })

  it('never throws and never leaves Devanagari behind, whatever it is given', () => {
    const odd = ['', '्', '़', 'ऻऻ', 'क्क्क्क', 'ॐ', 'अअअअअ', 'कं', 'का‍म', 'ँ', 'ः']
    for (const w of odd) {
      const out = devanagariToRoman(w)
      expect(typeof out).toBe('string')
      expect(out, JSON.stringify(w)).not.toMatch(/[ऀ-ॿ]/u)
    }
  })

  it('gives non-empty output for any word made of ordinary letters', () => {
    for (const w of ['क', 'का', 'कि', 'कु', 'के', 'को', 'अब', 'इस', 'उस', 'एक', 'ओर']) {
      expect(devanagariToRoman(w).length, w).toBeGreaterThan(0)
    }
  })
})

describe('Roman to Devanagari', () => {
  it('converts the words it knows', () => {
    expect(romanToDevanagari('kaise')).toBe('कैसे')
    expect(romanToDevanagari('Funding')).toBe('फंडिंग')
  })

  it('returns a word it does not know unchanged, rather than guessing a wrong spelling', () => {
    for (const w of ['quarterly', 'zindabad', 'kitab', 'school', '2024']) {
      expect(romanToDevanagari(w)).toBe(w)
    }
  })
})

describe('script detection', () => {
  it('detects Devanagari and Latin', () => {
    expect(hasDevanagari('नमस्ते')).toBe(true)
    expect(hasDevanagari('hello')).toBe(false)
    expect(hasLatin('hello')).toBe(true)
    expect(hasLatin('नमस्ते')).toBe(false)
    expect(hasLatin('AI-वाला') && hasDevanagari('AI-वाला')).toBe(true)
  })
})
