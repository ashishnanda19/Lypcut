import { describe, expect, it } from 'vitest'
import type { StyleStatus } from '@/types'
import {
  connectNotice,
  describeStatus,
  maybe,
  numbersFor,
  parseMetricsCsv,
  styleName,
} from './logic'

describe('numbers pasted from a spreadsheet', () => {
  it('reads a header, in any order, and leaves out what is blank rather than making it 0', () => {
    const r = parseMetricsCsv(
      'Saves,File name,Views,Likes\n300,best.mp4,"9,000",800\n, second.mp4 ,,',
    )
    expect(r.errors).toEqual([])
    expect(r.rows).toEqual([
      { fileName: 'best.mp4', views: 9000, likes: 800, saves: 300 },
      { fileName: 'second.mp4' },
    ])
  })

  it('assumes the order file, views, likes, comments, saves, shares, share watched when there is no header', () => {
    const r = parseMetricsCsv('a.mp4,100,10,2,5,1,62.5%\nb.mp4\t200\t20')
    expect(r.rows).toEqual([
      {
        fileName: 'a.mp4',
        views: 100,
        likes: 10,
        comments: 2,
        saves: 5,
        shares: 1,
        avgWatchPct: 62.5,
      },
      { fileName: 'b.mp4', views: 200, likes: 20 },
    ])
  })

  it('names the line of anything it cannot use, and uses the rest', () => {
    const r = parseMetricsCsv(
      'file,views,watch\na.mp4,abc,\nb.mp4,10,120\n,5,5\nc.mp4,-3,\nd.mp4,1.5,\ne.mp4,7,40',
    )
    expect(r.rows).toEqual([{ fileName: 'e.mp4', views: 7, avgWatchPct: 40 }])
    expect(r.errors).toEqual([
      'Line 2: “abc” is not a number.',
      'Line 3: the share watched must be between 0 and 100.',
      'Line 4: the file name is missing.',
      'Line 5: “-3” is not a number.',
      'Line 6: “1.5” should be a whole number.',
    ])
  })

  it('is empty for nothing, and keeps a real 0', () => {
    expect(parseMetricsCsv('  \n ')).toEqual({ rows: [], errors: [] })
    expect(parseMetricsCsv('a.mp4,100,0').rows[0]).toEqual({
      fileName: 'a.mp4',
      views: 100,
      likes: 0,
    })
  })

  it('matches numbers to the files chosen by name, with or without the extension, and says what matched nothing', () => {
    const rows = parseMetricsCsv('best,100\nSecond.MP4,200\nmissing.mp4,5').rows
    const m = numbersFor(rows, ['best.mp4', 'second.mp4', 'third.mp4'])
    expect(m.used.map((r) => r.fileName)).toEqual(['best', 'Second.MP4'])
    expect(m.unmatched).toEqual(['missing.mp4'])
  })
})

describe('coming back from Instagram', () => {
  it('says "Switch to a Creator account, it is free" for a personal account, and offers the upload', () => {
    const n = connectNotice('0', 'not_professional_account')!
    expect(n.title).toBe('Switch to a Creator account, it is free')
    expect(n.body).toMatch(/upload a few of your Reels here instead/)
    expect(n.offerUpload).toBe(true)
  })

  it('has a message for every reason, and nothing for a visit that is not a return', () => {
    for (const r of [
      'denied',
      'invalid_state',
      'permission_denied',
      'exchange_failed',
      'unavailable',
    ]) {
      const n = connectNotice('0', r)!
      expect(n.title.length, r).toBeGreaterThan(5)
      expect(n.body, r).not.toMatch(/undefined|reason/)
    }
    expect(connectNotice('1', null)).toMatchObject({ tone: 'success' })
    expect(connectNotice(null, null)).toBeNull()
    expect(connectNotice(null, 'denied')).toBeNull()
    expect(connectNotice('0', 'something_new')!.tone).toBe('error')
  })
})

describe('where learning is', () => {
  const status = (over: Partial<StyleStatus>): StyleStatus => ({
    state: 'idle',
    progress: 0,
    reels: { total: 0, analysed: 0, analysing: 0, pending: 0, failed: 0 },
    failed: [],
    updatedAt: null,
    needs: null,
    ...over,
  })

  it('shows progress while learning or reading Instagram', () => {
    const a = describeStatus(
      status({
        state: 'analysing',
        progress: 40,
        reels: { total: 5, analysed: 2, analysing: 3, pending: 0, failed: 0 },
      }),
      false,
    )
    expect(a).toMatchObject({ kind: 'working', progress: 40 })
    expect(a.body).toContain('2 of 5 Reels')
    expect(describeStatus(status({ state: 'syncing', progress: 10 }), true)).toMatchObject({
      kind: 'working',
      title: 'Reading your Instagram',
    })
  })

  it('asks to reconnect when Instagram stopped accepting the connection, and says the profile is the last good one', () => {
    const v = describeStatus(status({ state: 'reauth_required' }), true)
    expect(v.kind).toBe('reconnect')
    expect(v.body).toMatch(/last time it worked/)
  })

  it('says learning did not finish, differently when there is a profile to fall back on', () => {
    expect(describeStatus(status({ state: 'failed' }), true).body).toMatch(/last time it worked/)
    expect(describeStatus(status({ state: 'failed' }), false).body).toMatch(
      /Upload your Reels again/,
    )
  })

  it('asks for the files when Instagram is connected but no video has been learned from', () => {
    const v = describeStatus(status({ needs: 'reel_files' }), true)
    expect(v.kind).toBe('needs_files')
    expect(v.body).toMatch(/not the videos/)
  })

  it('has nothing to say when it is ready or idle, or when there is no status', () => {
    expect(describeStatus(status({ state: 'ready' }), true).kind).toBe('none')
    expect(describeStatus(status({}), false).kind).toBe('none')
    expect(describeStatus(undefined, false).kind).toBe('none')
  })
})

describe('names', () => {
  it('uses the editor’s name for a look, and Custom for captions it has no look for', () => {
    expect(styleName('saffron-pop')).toBe('Saffron Pop')
    expect(styleName('custom')).toBe('Custom')
  })
  it('shows a dash for a number that is not known, and keeps a real zero', () => {
    expect(maybe(null, String)).toBe('–')
    expect(maybe(undefined, String)).toBe('–')
    expect(maybe(0, String)).toBe('0')
  })
})
