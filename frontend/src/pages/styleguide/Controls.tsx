import { useState } from 'react'
import { ArrowRight, Heart, Scissors, Search, Settings2, Trash2 } from 'lucide-react'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogClose,
  DialogTrigger,
} from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Select } from '@/components/ui/Select'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/Sheet'
import { Skeleton } from '@/components/ui/Skeleton'
import { Stepper } from '@/components/ui/Stepper'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { toast } from '@/components/ui/Toast'
import { KeyboardShortcutHint } from '@/components/domain/KeyboardShortcutHint'
import { MetricChip } from '@/components/domain/MetricChip'
import { Section, Stage } from './Section'

const steps = [
  { id: 'up', label: 'Uploaded', description: 'Your video is safe with us.' },
  { id: 'split', label: 'Splitting into clips', description: 'Finding natural breaks.' },
  { id: 'tx', label: 'Transcribing', description: 'Hindi and English detected.' },
  { id: 'idx', label: 'Indexing scenes and speakers' },
  { id: 'ready', label: 'Ready' },
]

export function Controls() {
  const [lang, setLang] = useState('hinglish')
  const [step, setStep] = useState(2)
  const [pct, setPct] = useState(62)

  return (
    <>
      <Section
        id="controls"
        title="Buttons and inputs"
        description="Pills for actions, 12px corners for fields. Every icon-only button needs a label."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Stage title="Buttons">
            <Button
              variant="primary"
              trailing={<ArrowRight className="size-4" aria-hidden="true" />}
            >
              Start free
            </Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="teal">Teal</Button>
            <Button variant="danger" leading={<Trash2 className="size-4" aria-hidden="true" />}>
              Delete
            </Button>
            <Button variant="primary" loading>
              Saving
            </Button>
            <Button size="sm" variant="primary">
              Small
            </Button>
            <Button size="lg" variant="primary">
              Large
            </Button>
            <Button disabled>Disabled</Button>
          </Stage>
          <Stage title="Icon buttons and shortcuts">
            <IconButton label="Split at playhead" shortcut={['S']}>
              <Scissors className="size-[18px]" aria-hidden="true" />
            </IconButton>
            <IconButton label="Search" variant="secondary">
              <Search className="size-[18px]" aria-hidden="true" />
            </IconButton>
            <IconButton label="Advanced settings" variant="active">
              <Settings2 className="size-[18px]" aria-hidden="true" />
            </IconButton>
            <IconButton label="Like" variant="primary" size="lg">
              <Heart className="size-5" aria-hidden="true" />
            </IconButton>
            <span className="ml-2 flex items-center gap-2 text-sm text-muted">
              Undo <KeyboardShortcutHint keys={['mod', 'Z']} />
            </span>
            <span className="flex items-center gap-2 text-sm text-muted">
              Redo <KeyboardShortcutHint keys={['mod', 'Shift', 'Z']} />
            </span>
          </Stage>
          <Stage title="Fields" className="items-start">
            <Input
              className="w-full sm:w-64"
              label="Project name"
              placeholder="Episode 42, funding talk"
              hint="You can rename it any time."
            />
            <Input
              className="w-full sm:w-64"
              label="Email"
              defaultValue="aarav@"
              error="Add the part after @, like aarav@gmail.com."
            />
            <Select
              className="w-full sm:w-64"
              label="Transcript language"
              value={lang}
              onValueChange={setLang}
              options={[
                { value: 'hinglish', label: 'Hinglish', hint: 'Roman letters' },
                { value: 'hi', label: 'हिन्दी', hint: 'Devanagari' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Stage>
          <Stage title="Tabs">
            <Tabs defaultValue="chat" className="w-full">
              <TabsList label="Editor panels">
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
                <TabsTrigger value="search">Search</TabsTrigger>
                <TabsTrigger value="history" badge={<Badge tone="saffron">3</Badge>}>
                  History
                </TabsTrigger>
              </TabsList>
              <TabsContent value="chat" className="pt-4 text-sm text-muted">
                Chat comes first. Everything else supports it.
              </TabsContent>
              <TabsContent value="transcript" className="pt-4 text-sm text-muted">
                Delete words to cut that part of the video.
              </TabsContent>
              <TabsContent value="search" className="pt-4 text-sm text-muted">
                Type a sentence, get the moment.
              </TabsContent>
              <TabsContent value="history" className="pt-4 text-sm text-muted">
                Every change, one click from undone.
              </TabsContent>
            </Tabs>
          </Stage>
        </div>
      </Section>

      <Section
        id="status"
        title="Status and feedback"
        description="Progress ends in a small cut-line, so it reads as the cut moving forward."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Stage title="Badges and metrics">
            <StatusBadge status="uploading" />
            <StatusBadge status="processing" />
            <StatusBadge status="ready" />
            <StatusBadge status="exported" />
            <StatusBadge status="failed" />
            <MetricChip label="Cuts" value="3" tone="coral" />
            <MetricChip label="Saved" value="0:42" tone="teal" />
            <MetricChip label="Hook" value="92" tone="saffron" />
          </Stage>
          <Stage title="Progress" className="flex-col items-stretch">
            <ProgressBar label="Uploading" value={pct} />
            <ProgressBar label="Preparing" value={null} tone="teal" size="sm" />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPct((p) => Math.max(0, p - 15))}>
                Less
              </Button>
              <Button size="sm" onClick={() => setPct((p) => Math.min(100, p + 15))}>
                More
              </Button>
            </div>
          </Stage>
          <Stage title="Stepper">
            <div className="w-full">
              <Stepper steps={steps} current={step} />
              <div className="mt-5 flex gap-2">
                <Button size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                  Back
                </Button>
                <Button size="sm" onClick={() => setStep((s) => Math.min(steps.length, s + 1))}>
                  Next step
                </Button>
              </div>
            </div>
          </Stage>
          <Stage title="Skeleton, toast, dialog and sheet" className="items-start">
            <div className="flex w-full items-center gap-3">
              <Skeleton className="size-14 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Button
              onClick={() =>
                toast({
                  title: 'Published',
                  description: 'Your Reel is live on the timeline.',
                  tone: 'success',
                })
              }
            >
              Toast
            </Button>
            <Button
              onClick={() => toast({ title: 'Pakad liya! Found 6 strong hooks.', tone: 'ai' })}
            >
              Assistant toast
            </Button>
            <Button
              onClick={() =>
                toast({
                  title: 'Upload failed',
                  description: 'Check your connection, then retry.',
                  tone: 'error',
                  actionLabel: 'Retry',
                })
              }
            >
              Error toast
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">Dialog</Button>
              </DialogTrigger>
              <DialogContent
                title="Delete this project?"
                description="The video and every version are removed. This cannot be undone."
              >
                <DialogFooter>
                  <DialogClose asChild>
                    <Button>Keep project</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="danger">Delete project</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">Sheet</Button>
              </SheetTrigger>
              <SheetContent title="Caption style" description="Pick how words appear on your Reel.">
                <p className="text-sm text-muted">Caption presets appear here in step 7.</p>
              </SheetContent>
            </Sheet>
          </Stage>
        </div>
        <div className="mt-4 rounded-panel border border-line bg-surface-1">
          <EmptyState
            title="No clips yet"
            description="Upload a long video and the assistant finds your strongest moments, each with a reason."
            action={<Button variant="primary">Upload a video</Button>}
          />
        </div>
      </Section>
    </>
  )
}
