import { useCallback, useEffect, useRef, useState } from 'react'
import type { Job } from '@/types'
import { jobsSocketUrl } from '@/lib/runtime'
import { api } from './client'

interface JobState {
  job: Job | null
  /** True while the live socket is connected; false when we fell back to polling. */
  live: boolean
  retry: () => Promise<void>
}

/**
 * Live job progress. Opens the jobs socket and listens for events; if the socket cannot
 * connect it quietly falls back to polling so the screen never gets stuck.
 */
export function useJob(jobId: string | null | undefined): JobState {
  const [job, setJob] = useState<Job | null>(null)
  const [live, setLive] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const jobRef = useRef<Job | null>(null)

  useEffect(() => {
    if (!jobId) return
    let closed = false
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null

    const accept = (j: Job) => {
      if (closed) return
      jobRef.current = j
      setJob(j)
      if (j.status === 'done' || j.status === 'failed') if (poll) clearInterval(poll)
    }

    const startPolling = () => {
      if (poll) return
      setLive(false)
      const tick = () =>
        api
          .get<Job>(`/jobs/${jobId}`)
          .then(accept)
          .catch(() => undefined)
      tick()
      poll = setInterval(tick, 900)
    }

    try {
      socket = new WebSocket(jobsSocketUrl())
      socket.onopen = () => {
        setLive(true)
        socket?.send(JSON.stringify({ type: 'subscribe', jobId }))
      }
      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { type: string; job?: Job }
          if (msg.type === 'job' && msg.job) accept(msg.job)
          else if (msg.type === 'error') startPolling()
        } catch {
          /* ignore malformed frames */
        }
      }
      socket.onerror = () => startPolling()
      socket.onclose = () => {
        if (!closed && jobRef.current?.status !== 'done' && jobRef.current?.status !== 'failed')
          startPolling()
      }
    } catch {
      startPolling()
    }

    return () => {
      closed = true
      if (poll) clearInterval(poll)
      if (socket && socket.readyState <= 1) socket.close()
    }
  }, [jobId, epoch])

  const retry = useCallback(async () => {
    if (!jobId) return
    const next = await api.post<Job>(`/jobs/${jobId}/retry`)
    jobRef.current = next
    setJob(next)
    setEpoch((n) => n + 1)
  }, [jobId])

  return { job: jobId ? job : null, live, retry }
}
