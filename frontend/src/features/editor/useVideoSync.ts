import { useEffect, type RefObject } from 'react'
import { srcTimeAt } from '@lypcut/timeline-core'
import { clock } from './clock'
import { shownTimeline, useEditor } from './store'

/**
 * Keeps one <video> element in step with the shared clock. The clock is the boss: the video
 * follows it, and is only re-seeked when it drifts, so playback stays smooth.
 *
 * The stand-in proxy clip is short, so a long source loops over it (`src % length`).
 * With a real proxy of the full length, `want` is simply the source time.
 */
const DRIFT_PLAYING = 0.3
const DRIFT_PAUSED = 0.05

export function useVideoSync(ref: RefObject<HTMLVideoElement | null>, role: 'main' | 'mirror') {
  const muted = useEditor((s) => s.muted)

  useEffect(() => {
    const v = ref.current
    if (v) v.muted = role === 'mirror' || muted
  }, [ref, role, muted])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const sync = (t: number, playing: boolean) => {
      const d = v.duration
      if (!Number.isFinite(d) || d <= 0) return
      const src = srcTimeAt(shownTimeline(useEditor.getState()), t)
      if (src === undefined) {
        if (!v.paused) v.pause()
        return
      }
      const want = src % d
      v.playbackRate = clock.rate
      if (playing) {
        if (Math.abs(v.currentTime - want) > DRIFT_PLAYING) v.currentTime = want
        if (v.paused) void v.play().catch(() => undefined)
      } else {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - want) > DRIFT_PAUSED) v.currentTime = want
      }
    }
    const off = clock.onFrame(sync)
    const ready = () => sync(clock.time, clock.playing)
    v.addEventListener('loadedmetadata', ready)
    ready()
    return () => {
      off()
      v.removeEventListener('loadedmetadata', ready)
      v.pause()
    }
  }, [ref])
}
