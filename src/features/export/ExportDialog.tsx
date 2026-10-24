import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Clapperboard, Download, FileCode2, Film, Info } from 'lucide-react'
import { api } from '@/api/client'
import { useJob } from '@/api/useJob'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { toast } from '@/components/ui/Toast'
import { useEditorData } from '@/features/editor/data'
import { headTimeline, useEditor } from '@/features/editor/store'
import { otioString } from '@/lib/timeline/otio'
import { timelineDuration } from '@/lib/timeline/queries'
import { formatDuration } from '@/lib/time'
import type { AspectId, Job } from '@/types'

const SIZES: Array<{ id: AspectId; label: string; px: string; hint: string }> = [
  {
    id: '9:16',
    label: 'Reel / Shorts',
    px: '1080 x 1920',
    hint: 'Instagram Reels, YouTube Shorts, TikTok',
  },
  { id: '4:5', label: 'Feed portrait', px: '1080 x 1350', hint: 'Instagram and Facebook feed' },
  { id: '1:1', label: 'Square', px: '1080 x 1080', hint: 'Feed, carousels, WhatsApp status' },
  { id: '16:9', label: 'Landscape', px: '1920 x 1080', hint: 'YouTube and websites' },
]

const QUALITY = [
  { value: 'draft', label: 'Draft (720p, fastest)', hint: 'Good for a quick look', factor: 0.12 },
  { value: 'standard', label: 'Standard (1080p)', hint: 'Best for posting', factor: 0.25 },
  {
    value: 'high',
    label: 'High (1080p, high bitrate)',
    hint: 'Larger file, cleaner motion',
    factor: 0.4,
  },
]

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'lypcut'

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function estimate(sec: number, factor: number) {
  const s = Math.max(5, Math.round(sec * factor))
  return s < 60 ? `about ${s} seconds` : `about ${Math.round(s / 60)} min`
}

/** Renders the current cut at a chosen size. The render itself is a mock; progress and the job flow are real. */
function RenderTab({ aspects, label }: { aspects: AspectId[]; label: string }) {
  const { project, videoUrl } = useEditorData()
  const tl = useEditor(headTimeline)
  const captionsOn = tl.settings.captionsOn
  const [aspect, setAspect] = useState<AspectId>(aspects[0]!)
  const [quality, setQuality] = useState('standard')
  const [burn, setBurn] = useState(captionsOn)
  const [jobId, setJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const { job } = useJob(jobId)
  const dur = timelineDuration(tl)
  const q = QUALITY.find((x) => x.value === quality)!
  const size = SIZES.find((s) => s.id === aspect)!
  const busy = starting || (!!job && job.status !== 'done' && job.status !== 'failed')

  const start = async () => {
    setStarting(true)
    try {
      const j = await api.post<Job>(`/projects/${project.id}/export`, {
        kind: 'export',
        durationMs: 4500 + dur * 18,
      })
      setJobId(j.id)
    } catch {
      toast({
        title: 'Could not start the export',
        description: 'Please try again.',
        tone: 'error',
      })
    } finally {
      setStarting(false)
    }
  }

  const download = async () => {
    try {
      const res = await fetch(videoUrl)
      save(await res.blob(), `${slug(project.title)}-${aspect.replace(':', 'x')}-DEMO.mp4`)
      toast({
        title: 'Demo file saved',
        description: 'This is the sample clip, not your edit. Real rendering is not connected yet.',
        tone: 'info',
      })
    } catch {
      toast({ title: 'Could not save the file', tone: 'error' })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {aspects.length > 1 && (
        <div
          role="radiogroup"
          aria-label={`${label} size`}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {aspects.map((id) => {
            const s = SIZES.find((x) => x.id === id)!
            const on = id === aspect
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => setAspect(id)}
                className={`rounded-card border p-3 text-left transition-colors ${on ? 'border-saffron bg-saffron-soft' : 'border-line bg-surface-2 hover:bg-surface-3'}`}
              >
                <span className="flex items-center justify-between text-sm font-semibold">
                  {s.label}
                  <span className="tnum text-xs font-normal text-muted">{id}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted">{s.px}</span>
                <span className="mt-1 block text-xs text-faint">{s.hint}</span>
              </button>
            )
          })}
        </div>
      )}

      <dl className="grid grid-cols-3 gap-3 rounded-card bg-surface-2 p-4 text-sm">
        <div>
          <dt className="text-xs text-muted">Format</dt>
          <dd className="font-semibold">MP4 {size.px}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Length</dt>
          <dd className="tnum font-semibold">{formatDuration(dur)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Render time</dt>
          <dd className="font-semibold">{estimate(dur, q.factor)}</dd>
        </div>
      </dl>

      <Select
        value={quality}
        onValueChange={setQuality}
        label="Quality"
        options={QUALITY.map(({ value, label: l, hint }) => ({ value, label: l, hint }))}
      />
      <Switch
        checked={burn}
        onCheckedChange={setBurn}
        label="Burn captions into the video"
        hint={
          captionsOn
            ? 'Uses the caption style you chose.'
            : 'Captions are off in this edit. Turn them on from the Reel properties.'
        }
        disabled={busy || !captionsOn}
      />

      <p
        role="note"
        className="flex gap-2 rounded-card border border-line bg-surface-1 p-3 text-xs text-muted"
      >
        <Info className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" />
        Video rendering is not connected in this build. The progress below is simulated and the
        downloaded MP4 is the sample clip, not your edit.
      </p>

      {job && (
        <div aria-live="polite" className="flex flex-col gap-2">
          <ProgressBar
            label="Export progress"
            value={job.status === 'done' ? 100 : job.progress}
            tone={job.status === 'done' ? 'teal' : 'saffron'}
          />
          <p className="text-sm text-muted">
            {job.status === 'failed'
              ? (job.error ?? 'The export failed.')
              : (job.detail ?? 'Rendering')}
          </p>
        </div>
      )}

      {job?.status === 'done' ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            size="lg"
            leading={<Download className="size-4" aria-hidden="true" />}
            onClick={() => void download()}
          >
            Download MP4
          </Button>
          <Button
            variant="ghost"
            size="lg"
            leading={<Check className="size-4" aria-hidden="true" />}
            onClick={() => setJobId(null)}
          >
            Export again
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          leading={<Clapperboard className="size-4" aria-hidden="true" />}
          onClick={() => void start()}
        >
          {busy ? 'Rendering…' : `Export ${label}`}
        </Button>
      )}
    </div>
  )
}

function ProjectTab() {
  const { project } = useEditorData()
  const tl = useEditor(headTimeline)
  const download = () => {
    save(
      new Blob([otioString(tl, project.title)], { type: 'application/json' }),
      `${slug(project.title)}.otio`,
    )
    toast({
      title: 'Project file saved',
      description: 'Open it in DaVinci Resolve, Premiere or any OpenTimelineIO app.',
      tone: 'success',
    })
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Take your cuts into another editor. The file lists every clip, gap and source range exactly
        as you see them in the timeline.
      </p>
      <div className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface-2 p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-teal-soft text-teal-text">
            <FileCode2 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold">OpenTimelineIO (.otio)</p>
            <p className="text-xs text-muted">
              Works with DaVinci Resolve, Premiere Pro and Final Cut via adapters.
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          leading={<Download className="size-4" aria-hidden="true" />}
          onClick={download}
        >
          Download
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-card border border-dashed border-line p-4 opacity-80">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-surface-3 text-muted">
            <Film className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold">CapCut project</p>
            <p className="text-xs text-muted">Direct CapCut export is coming soon.</p>
          </div>
        </div>
        <Button disabled>Coming soon</Button>
      </div>
    </div>
  )
}

export function ExportDialog() {
  const navigate = useNavigate()
  const { project } = useEditorData()
  return (
    <Dialog open onOpenChange={(o) => !o && navigate(`/app/project/${project.id}`)}>
      <DialogContent title="Export" description={`"${project.title}"`} size="md">
        <Tabs defaultValue="reel">
          <TabsList label="Export type" className="mb-5">
            <TabsTrigger value="reel">Reel</TabsTrigger>
            <TabsTrigger value="sizes">Other sizes</TabsTrigger>
            <TabsTrigger value="project">Editor project</TabsTrigger>
          </TabsList>
          <TabsContent value="reel">
            <RenderTab aspects={['9:16']} label="Reel" />
          </TabsContent>
          <TabsContent value="sizes">
            <RenderTab aspects={['4:5', '1:1', '16:9']} label="video" />
          </TabsContent>
          <TabsContent value="project">
            <ProjectTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
