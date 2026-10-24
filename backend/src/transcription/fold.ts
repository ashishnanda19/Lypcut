/**
 * The search form of a word. Roman Hinglish has no fixed spelling, and speech recognition adds its own
 * ("funding" arrives as "phunding" or "fundiing"), so a literal match would miss things a person would
 * call identical. Both what is stored and what is searched for go through this, so they meet in the middle.
 *
 * It is deliberately blunt: it removes distinctions Hinglish spelling does not reliably make (ph/f, long
 * and short vowels, doubled letters, w/v, z/j, c/k), and nothing more. Words that merely sound alike but
 * are spelled further apart are left to the database's trigram matching.
 */
export function hinglishFold(roman: string): string {
  return roman
    .replace(/ph/g, 'f')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/chh/g, 'ch')
    .replace(/(ch|sh|kh|gh|th|dh|bh|jh)\1+/g, '$1')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?!h)/g, 'k')
}

/** Lower case, accents removed, only letters and digits left, then folded as above. */
export function foldForSearch(s: string): string {
  const plain = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Devanagari}]/gu, '')
  return hinglishFold(plain)
}
