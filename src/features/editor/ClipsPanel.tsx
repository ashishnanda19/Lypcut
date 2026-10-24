import { useState } from 'react'
import { BookOpen, Sparkles } from 'lucide-react'
import { ClipCard } from '@/components/domain/ClipCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { formatRange } from '@/lib/time'
import { timeAtSource } from '@/lib/timeline/queries'
import { clock } from './clock'
import { useEditorData } from './data'
import { addRangeToTimeline } from './SearchPanel'
import { headTimeline, useEditor } from './store'

export function ClipsPanel() {
  const { highlights, chapters, videoUrl } = useEditorData()
  const askChat = useEditor((s) => s.askChat)
  const [view, setView] = useState('highlights')
  const sorted = [...highlights].sort((a, b) => b.hookScore - a.hookScore)

  return (
    <Tabs value={view} onValueChange={setView} className="flex min-h-0 flex-1 flex-col">
      <TabsList label="Clips and chapters" className="mb-3 self-start">
        <TabsTrigger
          value="highlights"
          icon={<Sparkles className="size-4" />}
          badge={sorted.length}
        >
          Highlights
        </TabsTrigger>
        <TabsTrigger
          value="chapters"
          icon={<BookOpen className="size-4" />}
          badge={chapters.length}
        >
          Chapters
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="highlights"
        className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pb-2"
      >
        {sorted.length === 0 && (
          <EmptyState
            size="sm"
            title="No strong hooks yet"
            description="Longer, more varied videos give the AI more to work with."
          />
        )}
        {sorted.map((h) => (
          <ClipCard
            key={h.id}
            seed={h.thumbSeed}
            title={h.title}
            start={h.start}
            end={h.end}
            score={h.hookScore}
            reason={h.reason}
            preview={{ src: videoUrl, start: h.start }}
            onAdd={() => addRangeToTimeline(h.start, h.end, h.title)}
            onMakeReel={() =>
              askChat({
                text: `Make a Reel: ${h.title}`,
                reel: { srcFrom: h.start, srcTo: h.end, title: h.title },
              })
            }
            onSend={() =>
              askChat({
                text: `What do you think of “${h.title}” (${formatRange(h.start, h.end)})?`,
                reel: { srcFrom: h.start, srcTo: h.end, title: h.title },
              })
            }
          />
        ))}
      </TabsContent>

      <TabsContent value="chapters" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
        {chapters.length === 0 ? (
          <EmptyState
            size="sm"
            title="No chapters"
            description="Chapters appear for videos with clear topic changes."
          />
        ) : (
          <ol className="space-y-1.5">
            {chapters.map((c, i) => {
              const at = timeAtSource(headTimeline(useEditor.getState()), c.start)
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={at === undefined}
                    onClick={() => at !== undefined && clock.seek(at)}
                    className="flex w-full items-center gap-3 rounded-card border border-line bg-surface-1 px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="tnum flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.title}</span>
                      <span className="tnum text-xs text-faint">
                        {formatRange(c.start, c.end)}
                        {at === undefined ? ' · cut' : ''}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </TabsContent>
    </Tabs>
  )
}
