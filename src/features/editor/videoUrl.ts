import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { isReal } from '@/lib/runtime'
import type { Project } from '@/types'
import { clock } from './clock'

const DEMO = '/demo/proxy.mp4'
/** Fetch a new link this long before the old one stops working. */
const MARGIN_MS = 5 * 60_000

/** When a presigned link stops working, read from the link itself (X-Amz-Date plus X-Amz-Expires). */
export function expiryOf(url: string): number | null {
  try {
    const q = new URL(url, 'http://x').searchParams
    const date = q.get('X-Amz-Date')
    const secs = Number(q.get('X-Amz-Expires'))
    const m = date && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date)
    if (!m || !Number.isFinite(secs) || secs <= 0) return null
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + secs * 1000
  } catch {
    return null
  }
}

/**
 * The editing proxy to play. Against the real backend the link expires (an hour by default) while an editing session
 * can last longer, so a fresh link is fetched shortly before it does, and never while the video is playing.
 */
export function useVideoUrl(project: Project): string {
  const proxy = project.assets.find((a) => a.kind === 'proxy')
  const given = proxy?.url ?? DEMO
  const [fresh, setFresh] = useState<{ from: string; url: string } | null>(null)
  const url = fresh && fresh.from === given ? fresh.url : given

  useEffect(() => {
    if (!isReal || !proxy?.url) return
    const expiry = expiryOf(url)
    if (!expiry) return
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const refresh = async () => {
      if (stopped) return
      // Swapping the source restarts the video, so wait for a pause.
      if (clock.playing) {
        timer = setTimeout(() => void refresh(), 20_000)
        return
      }
      try {
        const res = await api.get<{ url: string }>(`/projects/${project.id}/assets/${proxy.id}/url`)
        if (!stopped) setFresh({ from: given, url: res.url })
      } catch {
        if (!stopped) timer = setTimeout(() => void refresh(), 30_000)
      }
    }
    timer = setTimeout(() => void refresh(), Math.max(15_000, expiry - Date.now() - MARGIN_MS))
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [url, given, project.id, proxy?.id, proxy?.url])

  return url
}
