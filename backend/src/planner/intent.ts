/**
 * The Reel questions (which part, how long, what pace) carry where they are in an `intent` string, which comes back from the
 * browser with the answer. Anything that comes back from a browser is untrusted, so it is read with this exact grammar and
 * refused if it says anything else:
 *
 *   reel|step=part|len=30|style=fast        every key optional, each at most once, each value from a fixed set
 */
export type ReelStep = 'part' | 'len' | 'style'

export interface ReelIntent {
  step: ReelStep
  part?: 'best' | 'here' | 'all'
  len?: string
  style?: 'fast' | 'calm'
}

const PARTS = new Set(['best', 'here', 'all'])
const STYLES = new Set(['fast', 'calm'])
const STEPS = new Set(['part', 'len', 'style'])
const LEN = /^(?:full|\d{1,3})$/

export const validLen = (v: string): boolean =>
  LEN.test(v) && (v === 'full' || (Number(v) >= 5 && Number(v) <= 180))

export function parseReelIntent(intent: string): ReelIntent | null {
  if (intent.length > 120) return null
  const [kind, ...rest] = intent.split('|')
  if (kind !== 'reel') return null
  const seen = new Set<string>()
  const out: Partial<ReelIntent> = {}
  for (const piece of rest) {
    const eq = piece.indexOf('=')
    if (eq < 1) return null
    const key = piece.slice(0, eq)
    const value = piece.slice(eq + 1)
    if (seen.has(key)) return null
    seen.add(key)
    if (key === 'step' && STEPS.has(value)) out.step = value as ReelStep
    else if (key === 'part' && PARTS.has(value)) out.part = value as ReelIntent['part']
    else if (key === 'style' && STYLES.has(value)) out.style = value as ReelIntent['style']
    else if (key === 'len' && validLen(value)) out.len = value
    else return null
  }
  return out.step ? (out as ReelIntent) : null
}

/** Whether an option id is one this step of the question can have. */
export function validAnswer(step: ReelStep, optionId: string): boolean {
  if (step === 'part') return PARTS.has(optionId)
  if (step === 'style') return STYLES.has(optionId)
  return validLen(optionId)
}
