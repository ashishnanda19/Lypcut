/**
 * Things that belong to one signed-in person (cached data, an open editing session) register here
 * to be cleared when they sign out or their session ends, so the next person on this browser sees none of it.
 */
const handlers = new Set<() => void>()

export function onSignOut(fn: () => void): () => void {
  handlers.add(fn)
  return () => handlers.delete(fn)
}

export function runSignOut() {
  handlers.forEach((fn) => fn())
}
