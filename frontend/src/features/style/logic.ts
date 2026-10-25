import { captionStyle } from '@/features/editor/captionStyles'
import type { StyleStatus } from '@/types'

/* ------------------------- numbers typed or pasted ------------------------- */

/** One Reel's numbers as the API takes them (`POST /style/upload`). Anything not given is left out: unknown is not 0. */
export interface ReelNumbers {
  fileName: string
  views?: number
  likes?: number
  comments?: number
  saves?: number
  shares?: number
  avgWatchPct?: number
}

export interface CsvResult {
  rows: ReelNumbers[]
  /** Problems, each naming the line, for the person to fix. A line with a problem is left out. */
  errors: string[]
}

type Column = keyof Omit<ReelNumbers, 'fileName'> | 'file'
const ORDER: Column[] = ['file', 'views', 'likes', 'comments', 'saves', 'shares', 'avgWatchPct']

/** What a spreadsheet header might call each column. */
function columnOf(heading: string): Column | null {
  const h = heading.toLowerCase().replace(/[^a-z]/g, '')
  if (['file', 'filename', 'name', 'reel', 'title', 'video'].includes(h)) return 'file'
  if (['views', 'plays', 'view'].includes(h)) return 'views'
  if (['likes', 'like'].includes(h)) return 'likes'
  if (['comments', 'comment'].includes(h)) return 'comments'
  if (['saves', 'save', 'saved'].includes(h)) return 'saves'
  if (['shares', 'share', 'sends'].includes(h)) return 'shares'
  if (
    [
      'avgwatchpct',
      'watch',
      'watchpct',
      'avgwatch',
      'watched',
      'averagewatch',
      'avgwatched',
      'retention',
    ].includes(h)
  )
    return 'avgWatchPct'
  return null
}

const split = (line: string) =>
  line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ''))

/**
 * Reads numbers pasted from a spreadsheet or typed as CSV: one Reel per line, the file name first, then views, likes, comments,
 * saves, shares and the share of the Reel people watch (0 to 100). A header line is used if there is one (in any order, with
 * the names a spreadsheet would give); otherwise that order is assumed. Commas inside numbers ("1,200"), a % sign, and blank
 * cells are fine: a blank is "not known", never 0.
 */
export function parseMetricsCsv(text: string): CsvResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return { rows: [], errors: [] }

  let columns = ORDER
  let first = 0
  const head = split(lines[0]!).map(columnOf)
  if (head.includes('file') && head.some((c) => c && c !== 'file')) {
    columns = head.map((c) => c ?? ('file' as Column)) as Column[]
    first = 1
  }

  const rows: ReelNumbers[] = []
  const errors: string[] = []
  for (let i = first; i < lines.length; i++) {
    const cells = split(lines[i]!)
    const row: ReelNumbers = { fileName: '' }
    let bad: string | null = null
    cells.forEach((cell, c) => {
      const col = columns[c]
      if (!col || bad) return
      if (col === 'file') {
        row.fileName = cell
        return
      }
      if (cell === '' || cell === '-' || cell === '–') return
      const n = Number(cell.replace(/[,\s%]/g, ''))
      if (!Number.isFinite(n) || n < 0) bad = `“${cell}” is not a number`
      else if (col === 'avgWatchPct') {
        if (n > 100) bad = 'the share watched must be between 0 and 100'
        else row.avgWatchPct = n
      } else if (!Number.isInteger(n)) bad = `“${cell}” should be a whole number`
      else row[col] = n
    })
    if (!row.fileName) bad ??= 'the file name is missing'
    if (bad) errors.push(`Line ${i + 1}: ${bad}.`)
    else rows.push(row)
  }
  return { rows, errors }
}

/** The numbers for the files that were actually chosen, matched by file name (with or without its extension). */
export function numbersFor(
  rows: ReelNumbers[],
  fileNames: string[],
): { used: ReelNumbers[]; unmatched: string[] } {
  const stem = (n: string) => n.replace(/\.[^./\\]+$/, '').toLowerCase()
  const have = new Set(fileNames.map(stem))
  const used = rows.filter((r) => have.has(stem(r.fileName)))
  return { used, unmatched: rows.filter((r) => !have.has(stem(r.fileName))).map((r) => r.fileName) }
}

/* --------------------------- coming back from Instagram --------------------------- */

export type ConnectReason =
  | 'denied'
  | 'invalid_state'
  | 'permission_denied'
  | 'not_professional_account'
  | 'exchange_failed'
  | 'unavailable'

export interface Notice {
  tone: 'success' | 'info' | 'error'
  title: string
  body: string
  /** Offer the upload path alongside: true when connecting is not going to work for this person. */
  offerUpload: boolean
}

/** What the Style page says when Instagram sends the person back with a result. */
export function connectNotice(connected: string | null, reason: string | null): Notice | null {
  if (connected === '1')
    return {
      tone: 'success',
      title: 'Instagram connected',
      body: 'Reading your Reels now. This takes a minute.',
      offerUpload: false,
    }
  if (connected !== '0') return null
  switch (reason as ConnectReason) {
    case 'not_professional_account':
      return {
        tone: 'info',
        title: 'Switch to a Creator account, it is free',
        body: 'Instagram only shares Reel numbers for Creator and Business accounts. In Instagram, open Settings, then Account type and tools, then Switch to professional account. You can come back and connect when that is done. Or upload a few of your Reels here instead: it works right now.',
        offerUpload: true,
      }
    case 'denied':
      return {
        tone: 'info',
        title: 'You cancelled on Instagram',
        body: 'Nothing was connected and nothing was read. You can try again, or upload a few Reels instead.',
        offerUpload: true,
      }
    case 'permission_denied':
      return {
        tone: 'error',
        title: 'Both permissions are needed',
        body: 'Lypcut needs to read your Reels and their numbers. It can do nothing else. Try again and approve both, or upload a few Reels instead.',
        offerUpload: true,
      }
    case 'unavailable':
      return {
        tone: 'error',
        title: 'Instagram did not answer',
        body: 'Nothing was connected. Try again in a moment.',
        offerUpload: false,
      }
    case 'invalid_state':
      return {
        tone: 'error',
        title: 'That sign-in expired',
        body: 'It took too long, or it was already used. Start again with Connect Instagram.',
        offerUpload: false,
      }
    default:
      return {
        tone: 'error',
        title: 'Could not connect Instagram',
        body: 'Instagram did not accept the sign-in. Try again, or upload a few Reels instead.',
        offerUpload: true,
      }
  }
}

/* ------------------------------------ status ------------------------------------ */

export interface StatusView {
  kind: 'working' | 'reconnect' | 'problem' | 'needs_files' | 'none'
  title: string
  body: string
  /** 0-100 while working, otherwise null. */
  progress: number | null
}

/** What the page says about where learning is. The last good profile stays on screen underneath, whatever this says. */
export function describeStatus(
  s: StatusView | StyleStatus | undefined,
  connected: boolean,
): StatusView {
  const none: StatusView = { kind: 'none', title: '', body: '', progress: null }
  if (!s || !('state' in s)) return none
  switch (s.state) {
    case 'analysing':
      return {
        kind: 'working',
        title: 'Learning your style',
        body: `${s.reels.analysed} of ${s.reels.analysed + s.reels.analysing} Reels done. This takes a few minutes: each one is watched and measured.`,
        progress: s.progress,
      }
    case 'syncing':
      return {
        kind: 'working',
        title: 'Reading your Instagram',
        body: 'Reading your Reels and their numbers.',
        progress: s.progress,
      }
    case 'reauth_required':
      return {
        kind: 'reconnect',
        title: 'Reconnect Instagram',
        body: 'Instagram stopped accepting the connection, which happens now and then. Your style below is from the last time it worked. Connect again to refresh it.',
        progress: null,
      }
    case 'failed':
      return {
        kind: 'problem',
        title: 'Learning did not finish',
        body: connected
          ? 'Your style below is from the last time it worked. Try again in a moment.'
          : 'Something went wrong while learning your style. Upload your Reels again to retry.',
        progress: null,
      }
    default:
      if (s.needs === 'reel_files')
        return {
          kind: 'needs_files',
          title: 'Add your best Reels',
          body: 'Instagram shares how your Reels did, but not the videos, so Lypcut cannot see how they were edited. Upload the files of your best few Reels (3 to 5 is plenty) to learn your style from them.',
          progress: null,
        }
      return none
  }
}

/* ------------------------------------- names ------------------------------------- */

/** The editor's name for a caption look, or "Custom" for captions it has no look for. */
export const styleName = (id: string) => (id === 'custom' ? 'Custom' : captionStyle(id).name)

/** "9.2K", or a dash for a number nobody has given. */
export function maybe(n: number | null | undefined, format: (n: number) => string): string {
  return n === null || n === undefined ? '–' : format(n)
}
