import { useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { PhoneFrame } from '@/components/domain/PhoneFrame'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { clock, useClock } from './clock'
import { useEditorData } from './data'
import { PropertiesPanel } from './PropertiesPanel'
import { ReelScreen } from './ReelScreen'
import { shownTimeline, useEditor } from './store'

function PlayOverlay() {
  const playing = useClock((_, p) => p)
  return (
    <button
      type="button"
      aria-label={playing ? 'Pause preview' : 'Play preview'}
      onClick={() => clock.toggle()}
      className={cn(
        'absolute inset-0 z-30 flex items-center justify-center transition-opacity',
        playing ? 'opacity-0 hover:opacity-100 focus-visible:opacity-100' : 'bg-black/20',
      )}
    />
  )
}

/** The live phone preview. Always the true result of the edit you are looking at. */
export function PhonePreview({
  width = 248,
  safeToggle = true,
}: {
  width?: number
  safeToggle?: boolean
}) {
  const { videoUrl, transcript } = useEditorData()
  const tl = useEditor(shownTimeline)
  const [safe, setSafe] = useState(false)
  return (
    <div className="flex flex-col items-center gap-3">
      <PhoneFrame width={width}>
        <ReelScreen
          timeline={tl}
          words={transcript.words}
          videoUrl={videoUrl}
          showSafeZones={safe}
          syncAs="mirror"
          className="absolute inset-0"
        />
        <PlayOverlay />
      </PhoneFrame>
      {safeToggle && (
        <Switch
          className="w-full max-w-[17rem]"
          label="Show Instagram safe zones"
          hint="Where app buttons sit over your video"
          checked={safe}
          onCheckedChange={setSafe}
        />
      )}
    </div>
  )
}

/** Right column: the phone, then Properties (collapsed in Simple mode). */
export function PhonePanel({ advanced }: { advanced: boolean }) {
  const [open, setOpen] = useState(false)
  const show = advanced || open
  return (
    <aside
      aria-label="Live Reel preview"
      className="scroll-thin flex min-h-0 w-[19rem] shrink-0 flex-col gap-5 overflow-y-auto pr-1"
    >
      <div>
        <h2 className="mb-3 text-sm font-semibold">Live Reel preview</h2>
        <PhonePreview />
      </div>
      <div className="border-t border-line pt-4">
        {advanced ? (
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="size-4 text-faint" aria-hidden="true" />
            Properties
          </h2>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="props-panel"
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-2 rounded-full py-1 text-sm font-semibold hover:text-accent"
          >
            <SlidersHorizontal className="size-4 text-faint" aria-hidden="true" />
            Captions and look
            <ChevronDown
              className={cn(
                'ml-auto size-4 text-faint transition-transform duration-200',
                open && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
        )}
        {show && (
          <div id="props-panel" className={cn(!advanced && 'mt-4')}>
            <PropertiesPanel advanced={advanced} />
          </div>
        )}
      </div>
    </aside>
  )
}
