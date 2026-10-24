import { useRef } from 'react'
import { useVideoSync } from './useVideoSync'

/** A <video> that follows the shared clock. It has no controls of its own on purpose. */
export function SyncedVideo({
  src,
  syncAs,
  className,
  fit = 'fill',
}: {
  src: string
  syncAs: 'main' | 'mirror'
  className?: string
  fit?: 'fill' | 'cover'
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useVideoSync(ref, syncAs)
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      loop={false}
      aria-hidden="true"
      tabIndex={-1}
      disablePictureInPicture
      className={className}
      style={{ objectFit: fit }}
    />
  )
}
