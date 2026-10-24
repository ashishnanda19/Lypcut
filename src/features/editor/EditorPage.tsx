import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  FileText,
  History,
  Keyboard,
  MessageCircle,
  Redo2,
  Search,
  Share,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { useChapters, useHighlights, useScenes, useTranscript } from '@/api/hooks'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { Logo } from '@/components/brand/Logo'
import { cn } from '@/lib/cn'
import { buildInitialTimeline } from '@/lib/timeline/build'
import { timelineDuration } from '@/lib/timeline/queries'
import { useAuth } from '@/stores/auth'
import { usePrefs } from '@/stores/prefs'
import type { Lang, Project } from '@/types'
import { ChatPanel } from './ChatPanel'
import { ClipsPanel } from './ClipsPanel'
import { clock } from './clock'
import { EditorDataProvider, type EditorData } from './data'
import { HistoryPanel } from './HistoryPanel'
import { openingMessage } from './planner'
import { PhonePanel, PhonePreview } from './PhonePanel'
import { PlayerPanel, Transport } from './PlayerPanel'
import { SearchPanel } from './SearchPanel'
import { ShortcutsDialog } from './ShortcutsDialog'
import { canRedo, canUndo, shownTimeline, useEditor } from './store'
import { TimelineView } from './Timeline'
import { TranscriptPanel } from './TranscriptPanel'
import { useBreakpoint } from './useBreakpoint'
import { useEditorShortcuts } from './useEditorShortcuts'
import { uid } from '@/lib/ids'

const TABS = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'transcript', label: 'Transcript', icon: FileText },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'clips', label: 'Clips', icon: Sparkles },
  { id: 'history', label: 'History', icon: History },
] as const

function LeftPanel({ compact }: { compact?: boolean }) {
  const tab = usePrefs((s) => s.tab)
  const setTab = usePrefs((s) => s.setTab)
  const value = TABS.some((t) => t.id === tab) ? tab : 'chat'
  const versions = useEditor((s) => s.versions.length - 1)
  const body = 'flex min-h-0 flex-1 flex-col'
  return (
    <Tabs value={value} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <TabsList label="Editor panels" className="mb-3">
        {TABS.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            icon={<t.icon className="size-4" aria-hidden="true" />}
            iconOnly={compact}
            badge={
              t.id === 'history' && versions > 0 ? (
                <span className="tnum rounded-full bg-surface-1 px-1.5 text-[10px]">
                  {versions}
                </span>
              ) : undefined
            }
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="chat" className={body}>
        <ChatPanel />
      </TabsContent>
      <TabsContent value="transcript" className={body}>
        <TranscriptPanel />
      </TabsContent>
      <TabsContent value="search" className={body}>
        <SearchPanel />
      </TabsContent>
      <TabsContent value="clips" className={body}>
        <ClipsPanel />
      </TabsContent>
      <TabsContent value="history" className={body}>
        <HistoryPanel />
      </TabsContent>
    </Tabs>
  )
}

function TopBar({
  project,
  advanced,
  setAdvanced,
  onHelp,
  compact,
}: {
  project: Project
  advanced: boolean
  setAdvanced: (v: boolean) => void
  onHelp: () => void
  compact: boolean
}) {
  const navigate = useNavigate()
  const canU = useEditor(canUndo)
  const canR = useEditor(canRedo)
  const st = useEditor.getState
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
      <IconButton label="Back to projects" onClick={() => navigate('/app')}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </IconButton>
      <Link to="/app" aria-label="Lypcut home" className="hidden rounded-full sm:block">
        <Logo size={24} withWordmark={false} />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-nowrap text-[15px] font-semibold">
        {project.title}
      </h1>
      {!compact && (
        <div
          role="radiogroup"
          aria-label="Editing mode"
          className="flex rounded-full bg-surface-2 p-0.5"
        >
          {[
            [false, 'Simple'],
            [true, 'Advanced'],
          ].map(([v, label]) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={advanced === v}
              onClick={() => setAdvanced(v as boolean)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                advanced === v
                  ? 'bg-surface-1 text-text shadow-soft'
                  : 'text-muted hover:text-text',
              )}
            >
              {label as string}
            </button>
          ))}
        </div>
      )}
      <IconButton label="Undo" shortcut={['mod', 'Z']} disabled={!canU} onClick={() => st().undo()}>
        <Undo2 className="size-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Redo"
        shortcut={['mod', 'Shift', 'Z']}
        disabled={!canR}
        onClick={() => st().redo()}
      >
        <Redo2 className="size-4" aria-hidden="true" />
      </IconButton>
      {!compact && (
        <IconButton label="Keyboard shortcuts" shortcut={['?']} onClick={onHelp}>
          <Keyboard className="size-4" aria-hidden="true" />
        </IconButton>
      )}
      <ThemeToggle />
      <Button
        size="sm"
        variant="primary"
        leading={<Share className="size-4" aria-hidden="true" />}
        onClick={() => navigate(`/app/project/${project.id}/export`)}
      >
        Export
      </Button>
    </header>
  )
}

function Skeletons() {
  return (
    <div className="grid h-dvh grid-rows-[3.5rem_1fr]" aria-busy="true" aria-label="Loading editor">
      <div className="border-b border-line" />
      <div className="grid min-h-0 gap-4 p-4 lg:grid-cols-[26rem_1fr_19rem]">
        <Skeleton className="h-full rounded-panel" />
        <Skeleton className="hidden h-full rounded-panel lg:block" />
        <Skeleton className="hidden h-full rounded-panel lg:block" />
      </div>
    </div>
  )
}

/** The editor. Loads the project's data, opens its session, then lays out the panels for the screen size. */
export default function EditorPage({ project }: { project: Project }) {
  const transcript = useTranscript(project.id)
  const scenes = useScenes(project.id)
  const highlights = useHighlights(project.id)
  const chapters = useChapters(project.id)
  const user = useAuth((s) => s.user)
  const advanced = usePrefs((s) => s.advanced)
  const setAdvanced = usePrefs((s) => s.setAdvanced)
  const bp = useBreakpoint()
  const [help, setHelp] = useState(false)
  const openHelp = useCallback(() => setHelp(true), [])
  useEditorShortcuts(openHelp)

  const ready = !!(transcript.data && scenes.data && highlights.data && chapters.data)
  const openedFor = useEditor((s) => s.projectId)
  const shown = useEditor((s) => (s.versions.length ? shownTimeline(s) : null))

  useEffect(() => {
    if (!ready || useEditor.getState().projectId === project.id) return
    const msg = openingMessage(
      user?.name ?? '',
      (user?.language ?? 'hinglish') as Lang,
      project.title,
    )
    useEditor
      .getState()
      .open(project.id, buildInitialTimeline(scenes.data!, project.durationSec), [
        { id: uid('m'), from: 'ai', text: msg.text, at: Date.now(), fresh: true, chips: msg.chips },
      ])
    clock.pause()
    clock.seek(0)
  }, [ready, project, scenes.data, user])

  // The clock's length is always the length of what is on screen.
  useEffect(() => {
    if (openedFor === project.id && shown) clock.setDuration(timelineDuration(shown))
  }, [shown, openedFor, project.id])

  useEffect(() => () => clock.pause(), [])

  const videoUrl = project.assets.find((a) => a.kind === 'proxy')?.url ?? '/demo/proxy.mp4'
  const data = useMemo<EditorData | null>(
    () =>
      ready
        ? {
            project,
            transcript: transcript.data!,
            scenes: scenes.data!,
            highlights: highlights.data!,
            chapters: chapters.data!,
            videoUrl,
          }
        : null,
    [ready, project, transcript.data, scenes.data, highlights.data, chapters.data, videoUrl],
  )

  const failed = transcript.isError || scenes.isError || highlights.isError || chapters.isError
  if (failed) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <EmptyState
          title="Could not open the editor"
          description="Something went wrong loading this video's transcript."
          action={
            <Button
              variant="primary"
              onClick={() =>
                void Promise.all([
                  transcript.refetch(),
                  scenes.refetch(),
                  highlights.refetch(),
                  chapters.refetch(),
                ])
              }
            >
              Try again
            </Button>
          }
        />
      </div>
    )
  }
  if (!data || openedFor !== project.id) return <Skeletons />

  return (
    <EditorDataProvider value={data}>
      <div className="flex h-dvh flex-col bg-[var(--bg)]">
        <a
          href="#timeline"
          className="sr-only z-[300] rounded-full bg-saffron px-4 py-2 font-semibold text-saffron-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to timeline
        </a>
        <TopBar
          project={project}
          advanced={advanced}
          setAdvanced={setAdvanced}
          onHelp={openHelp}
          compact={bp === 'mobile'}
        />

        {bp === 'mobile' ? (
          <main id="main" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <div className="flex shrink-0 items-center gap-4">
              <PhonePreview width={132} safeToggle={false} />
              <div className="min-w-0 flex-1">
                <Transport compact />
                <p className="mt-2 text-xs text-faint">
                  Chat to edit. The full timeline is on a larger screen.
                </p>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col rounded-panel border border-line bg-surface-1 p-3">
              <LeftPanel compact />
            </div>
          </main>
        ) : (
          <main id="main" className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
            <div
              className={cn(
                'grid min-h-0 flex-1 gap-4',
                bp === 'desktop'
                  ? 'grid-cols-[clamp(22rem,31vw,29rem)_minmax(0,1fr)_19rem]'
                  : 'grid-cols-[22rem_minmax(0,1fr)]',
              )}
            >
              <div className="flex min-h-0 flex-col rounded-panel border border-line bg-surface-1 p-4">
                <LeftPanel compact={bp === 'tablet'} />
              </div>
              <PlayerPanel />
              {bp === 'desktop' && <PhonePanel advanced={advanced} />}
            </div>
            <div id="timeline" className="h-[clamp(240px,36vh,340px)] shrink-0">
              <TimelineView advanced={advanced} onShortcuts={openHelp} />
            </div>
          </main>
        )}
        <ShortcutsDialog open={help} onOpenChange={setHelp} />
        <Outlet />
      </div>
    </EditorDataProvider>
  )
}
