export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

/** "mod" renders as ⌘ on Apple platforms and Ctrl elsewhere. */
export function keyLabel(key: string): string {
  const k = key.toLowerCase()
  if (k === 'mod') return isMac ? '⌘' : 'Ctrl'
  if (k === 'shift') return isMac ? '⇧' : 'Shift'
  if (k === 'alt') return isMac ? '⌥' : 'Alt'
  if (k === 'enter') return '↵'
  if (k === 'delete') return isMac ? '⌫' : 'Del'
  if (k === 'space') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key
}
