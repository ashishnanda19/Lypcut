import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useSearch } from '@/api/hooks'
import { ClipCard } from '@/components/domain/ClipCard'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { toast } from '@/components/ui/Toast'
import { formatRange } from '@/lib/time'
import { itemEnd, timelineDuration, trackByKind } from '@/lib/timeline/queries'
import { uid } from '@/lib/ids'
import { tokenize } from '@/lib/search'
import type { SearchResult, Timeline, TimelineItem, TimelineOp, Word } from '@/types'
import { useEditorData } from './data'
import { commitYou } from './timelineActions'
import { clock } from './clock'
import { headTimeline, useEditor } from './store'

const IDEAS = ['where I talk about funding', 'hiring ki baat', 'पहली गलती', 'product market fit']

/** Add a stretch of the source to the end of the edit, with its voice. */
export function addRangeOp(tl: Timeline, from: number, to: number, label: string): TimelineOp {
  const v = trackByKind(tl, 'video')
  const a = trackByKind(tl, 'audio')
  const start = timelineDuration(tl)
  const base = { start, duration: to - from, srcIn: from }
  const items: TimelineItem[] = [
    { id: uid('i'), trackId: v?.id ?? 'trk_video', kind: 'video', label, ...base },
    { id: uid('i'), trackId: a?.id ?? 'trk_audio', kind: 'audio', label: 'Voice', ...base },
  ]
  return { type: 'patch', upsert: items, remove: [] }
}

export function addRangeToTimeline(from: number, to: number, label: string) {
  const tl = headTimeline(useEditor.getState())
  if (commitYou(addRangeOp(tl, from, to, label), `Added “${label}”`)) {
    const end = itemEnd(
      Object.values(headTimeline(useEditor.getState()).items).sort(
        (x, y) => itemEnd(y) - itemEnd(x),
      )[0]!,
    )
    clock.seek(Math.max(0, end - (to - from)))
    toast({ title: 'Added to the end of your edit', description: label, tone: 'success' })
  }
}

/** The matched sentence with the matching words highlighted. */
function Highlighted({ r, words }: { r: SearchResult; words: Word[] }) {
  const hit = new Set(r.matched)
  const out = []
  for (let i = r.from; i < r.to; i++) {
    const w = words[i]!
    out.push(hit.has(i) ? <mark key={i}>{w.text}</mark> : w.text, ' ')
  }
  return <>{out}</>
}

export function SearchPanel() {
  const { project, transcript, videoUrl } = useEditorData()
  const query = useEditor((s) => s.query)
  const setQuery = useEditor((s) => s.setQuery)
  const askChat = useEditor((s) => s.askChat)
  const [debounced, setDebounced] = useState(query)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 160)
    return () => clearTimeout(id)
  }, [query])
  const { data, isFetching, isError, refetch } = useSearch(project.id, debounced)
  const typing = query.trim().length >= 2
  const results = typing ? (data ?? []) : []
  const loading = typing && isFetching && !results.length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <label htmlFor="moment-search" className="sr-only">
          Find a moment in your video
        </label>
        <div className="flex h-14 items-center gap-3 rounded-full border border-line bg-surface-2 px-5 transition-colors focus-within:border-saffron focus-within:bg-surface-1">
          <Search className="size-5 shrink-0 text-faint" aria-hidden="true" />
          <input
            id="moment-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Describe a moment, like “where I talk about funding”"
            autoComplete="off"
            lang="hi"
            className="min-w-0 flex-1 bg-transparent text-base text-text placeholder:text-faint focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="rounded-full p-1 text-faint hover:text-text"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div aria-live="polite" className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pb-2">
        {!typing && (
          <div className="px-1">
            <p className="text-sm text-muted">
              Type a sentence in Hindi, Hinglish or English. You get the exact moment, with a
              thumbnail and timestamps.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {IDEAS.map((i) => (
                <button
                  key={i}
                  type="button"
                  lang="hi"
                  onClick={() => setQuery(i)}
                  className="rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:border-saffron/50 hover:bg-saffron-soft hover:text-accent"
                >
                  {i}
                </button>
              ))}
            </div>
          </div>
        )}
        {loading &&
          [0, 1].map((i) => (
            <div
              key={i}
              className="overflow-hidden rounded-card border border-line"
              aria-hidden="true"
            >
              <Skeleton className="aspect-video rounded-none" />
              <div className="space-y-2 p-3.5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            </div>
          ))}
        {isError && (
          <EmptyState
            size="sm"
            title="Search hit a snag"
            description="Try again in a moment."
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                Try again
              </Button>
            }
          />
        )}
        {typing && !loading && !isError && results.length === 0 && (
          <EmptyState
            size="sm"
            title={`Nothing found for “${query.trim()}”`}
            description="Try a different word, or describe it another way. Hindi works too."
          />
        )}
        {results.length > 0 && (
          <p className="tnum px-1 text-xs text-faint">
            {results.length} moment{results.length > 1 ? 's' : ''} found
          </p>
        )}
        {results.map((r) => (
          <ClipCard
            key={r.id}
            seed={r.thumbSeed}
            title={`${formatRange(r.start, r.end)}`}
            start={r.start}
            end={r.end}
            score={r.relevance}
            scoreLabel="Relevance"
            matched={<Highlighted r={r} words={transcript.words} />}
            preview={{ src: videoUrl, start: r.start }}
            onAdd={() =>
              addRangeToTimeline(
                r.start,
                r.end,
                tokenize(query).slice(0, 3).join(' ') || 'Search result',
              )
            }
            onMakeReel={() =>
              askChat({
                text: `Make a Reel from ${formatRange(r.start, r.end)}`,
                reel: { srcFrom: r.start, srcTo: r.end, title: query.trim() || 'Search result' },
              })
            }
            onSend={() =>
              askChat({
                text: `About ${formatRange(r.start, r.end)}: “${transcript.words
                  .slice(r.from, r.to)
                  .map((w) => w.text)
                  .join(' ')}”`,
                reel: { srcFrom: r.start, srcTo: r.end, title: query.trim() || 'This moment' },
              })
            }
          />
        ))}
      </div>
    </div>
  )
}
