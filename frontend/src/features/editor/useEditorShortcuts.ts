import { useEffect } from 'react'
import { clock } from './clock'
import { usePrefs } from '@/stores/prefs'
import { addMarkerAtPlayhead, deleteSelection, splitAtPlayhead } from './timelineActions'
import { useEditor } from './store'

const TYPING = 'input, textarea, select, [contenteditable="true"]'
const INTERACTIVE =
  'button, a, [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="slider"]'

/**
 * Keyboard shortcuts for the whole editor. They are ignored while typing, and a few keys
 * (Space, arrows) step aside when a control that uses them has focus.
 */
export function useEditorShortcuts(onHelp: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.defaultPrevented || e.isComposing) return
      if (el?.closest(TYPING)) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const ed = useEditor.getState()
      const insideList = !!el?.closest('[role="grid"], [role="document"]')

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) ed.redo()
        else ed.undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        ed.redo()
        return
      }
      if (mod || e.altKey) return

      switch (e.key) {
        case ' ':
          if (el?.closest(INTERACTIVE) && !insideList) return
          e.preventDefault()
          clock.toggle()
          return
        case 'ArrowLeft':
        case 'ArrowRight':
          if (insideList && !e.shiftKey) return
          e.preventDefault()
          clock.seek(clock.time + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1))
          return
        case 'Home':
          e.preventDefault()
          clock.seek(0)
          return
        case 'End':
          e.preventDefault()
          clock.seek(clock.duration)
          return
        case 'Delete':
        case 'Backspace':
          if (el?.closest(INTERACTIVE) && !insideList) return
          e.preventDefault()
          deleteSelection(e.shiftKey)
          return
        case 'Escape':
          if (ed.preview) ed.previewEdit(null)
          else ed.setSelection([])
          return
        case '?':
          e.preventDefault()
          onHelp()
          return
        case '+':
        case '=':
          window.dispatchEvent(new CustomEvent('lypcut:zoom', { detail: 1.3 }))
          return
        case '-':
          window.dispatchEvent(new CustomEvent('lypcut:zoom', { detail: 1 / 1.3 }))
          return
        case '/':
          e.preventDefault()
          usePrefs.getState().setTab('search')
          setTimeout(() => document.getElementById('moment-search')?.focus(), 60)
          return
      }
      if (key === 's' && !e.shiftKey) {
        e.preventDefault()
        splitAtPlayhead()
      } else if (key === 'm') {
        e.preventDefault()
        if (e.shiftKey) ed.setMuted(!ed.muted)
        else addMarkerAtPlayhead()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onHelp])
}

export const SHORTCUT_GROUPS: Array<{
  title: string
  items: Array<{ keys: string[]; label: string }>
}> = [
  {
    title: 'Playback',
    items: [
      { keys: ['Space'], label: 'Play or pause' },
      { keys: ['←'], label: 'Back 1 second' },
      { keys: ['→'], label: 'Forward 1 second' },
      { keys: ['Shift', '←'], label: 'Back 5 seconds' },
      { keys: ['Shift', '→'], label: 'Forward 5 seconds' },
      { keys: ['Home'], label: 'Go to the start' },
      { keys: ['End'], label: 'Go to the end' },
      { keys: ['Shift', 'M'], label: 'Mute or unmute' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: ['S'], label: 'Split at the playhead' },
      { keys: ['Delete'], label: 'Delete the selected clips' },
      { keys: ['Shift', 'Delete'], label: 'Ripple delete (close the gap)' },
      { keys: ['M'], label: 'Add a marker' },
      { keys: ['mod', 'Z'], label: 'Undo' },
      { keys: ['mod', 'Shift', 'Z'], label: 'Redo' },
      { keys: ['Esc'], label: 'Stop previewing, or clear selection' },
    ],
  },
  {
    title: 'Timeline and panels',
    items: [
      { keys: ['+'], label: 'Zoom in' },
      { keys: ['-'], label: 'Zoom out' },
      { keys: ['mod', 'Scroll'], label: 'Zoom with the mouse' },
      { keys: ['/'], label: 'Search for a moment' },
      { keys: ['?'], label: 'Show this list' },
    ],
  },
  {
    title: 'In the transcript',
    items: [
      { keys: ['Click'], label: 'Jump to that word' },
      { keys: ['Shift', 'Click'], label: 'Extend the selection' },
      { keys: ['Delete'], label: 'Cut the selected words' },
    ],
  },
]
