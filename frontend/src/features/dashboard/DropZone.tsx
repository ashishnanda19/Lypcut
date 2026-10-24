import { useRef, useState, type DragEvent } from 'react'
import { UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { toast } from '@/components/ui/Toast'

interface Props {
  onFiles: (files: File[]) => void
  compact?: boolean
}

export const ACCEPT =
  'video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v'

export function pickVideos(list: FileList | File[] | null): File[] {
  const all = Array.from(list ?? [])
  const videos = all.filter(
    (f) => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name),
  )
  if (all.length && videos.length < all.length) {
    toast({
      title: 'Only video files can be added',
      description: 'Try MP4, MOV, MKV or WebM.',
      tone: 'error',
    })
  }
  return videos
}

/** Big drop target with a real file input behind it, so keyboard and screen reader users get the same path. */
export function DropZone({ onFiles, compact }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const drop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const files = pickVideos(e.dataTransfer.files)
    if (files.length) onFiles(files)
  }

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        setOver(true)
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
      className={cn(
        'relative flex flex-col items-center justify-center rounded-panel border-2 border-dashed text-center transition-[border-color,background-color] duration-150',
        compact ? 'gap-3 px-6 py-8' : 'gap-4 px-6 py-12',
        over
          ? 'border-saffron bg-saffron-soft'
          : 'border-line-strong bg-surface-1 hover:border-saffron/60',
      )}
    >
      <span
        className={cn(
          'flex size-14 items-center justify-center rounded-full bg-saffron-soft text-accent',
          over && 'leap',
        )}
      >
        <UploadCloud className="size-7" aria-hidden="true" />
      </span>
      <div>
        <p className="text-lg font-semibold">
          {over ? 'Drop to upload' : 'Drop a long video here'}
        </p>
        <p className="mt-1 text-sm text-muted">
          MP4, MOV, MKV or WebM. Up to 3 hours. You can add several at once.
        </p>
      </div>
      <Button variant="primary" size="lg" onClick={() => input.current?.click()}>
        Choose video
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose video files to upload"
        data-testid="video-input"
        onChange={(e) => {
          const files = pickVideos(e.target.files)
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </div>
  )
}
