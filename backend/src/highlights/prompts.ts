import { readFileSync } from 'node:fs'

/**
 * The system prompts live in versioned files (prompts/<name>.vN.md) so a change to the wording is a reviewable diff and
 * the version in use is a name, not a guess. This folder sits two levels above both src/highlights and dist/highlights.
 */
const cache = new Map<string, string>()

export function loadPrompt(name: string): string {
  let text = cache.get(name)
  if (text === undefined) {
    text = readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), 'utf8').trim()
    cache.set(name, text)
  }
  return text
}
