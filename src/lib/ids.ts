let counter = 0

/** Short unique id. Not cryptographic; good enough for client-side items and messages. */
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
