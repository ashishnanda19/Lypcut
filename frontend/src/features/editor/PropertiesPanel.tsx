import { useEffect, useMemo, useState } from 'react'
import { Check, Crosshair, Eraser } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/cn'
import { usePrefs } from '@/stores/prefs'
import { useBrand } from '@/stores/brand'
import type { AspectId } from '@/types'
import { CaptionPhrase } from './CaptionView'
import { CAPTION_STYLES, captionStyle } from './captionStyles'
import { clock } from './clock'
import { useEditorData } from './data'
import { headTimeline, useEditor } from './store'

/** A repeating counter, only while `on`. Drives the live sample in a style tile. */
function useTicker(on: boolean, ms = 520) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setN((v) => v + 1), ms)
    return () => clearInterval(id)
  }, [on, ms])
  return n
}

function StyleTile({
  id,
  selected,
  onPick,
}: {
  id: string
  selected: boolean
  onPick: () => void
}) {
  const { transcript } = useEditorData()
  const dev = usePrefs((s) => s.captionDev)
  const [hover, setHover] = useState(false)
  const style = captionStyle(id)
  const words = useMemo(() => transcript.words.slice(0, 4), [transcript])
  const n = useTicker(hover || selected)
  const active = hover || selected ? n % (words.length + 1) : 1
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${style.name} captions`}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className={cn(
        'group relative overflow-hidden rounded-card border text-left transition-[border-color,transform] duration-150 active:scale-[0.98]',
        selected ? 'border-saffron' : 'border-line hover:border-line-strong',
      )}
    >
      <div
        className="relative flex h-[84px] items-center justify-center bg-[linear-gradient(135deg,#232b3a,#12161d)]"
        style={{ containerType: 'inline-size' }}
      >
        <div className="w-full origin-center scale-[0.62]">
          <CaptionPhrase
            words={words}
            active={Math.min(active, words.length - 1)}
            style={style}
            dev={dev}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-[13px] font-medium">{style.name}</span>
        {selected && <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />}
      </div>
    </button>
  )
}

const FONTS = [
  { value: '', label: 'Style default' },
  { value: '"Inter Variable", "Noto Sans Devanagari", sans-serif', label: 'Inter' },
  { value: '"Noto Sans Devanagari", "Inter Variable", sans-serif', label: 'Noto Sans Devanagari' },
  { value: 'Georgia, "Noto Sans Devanagari", serif', label: 'Serif' },
  { value: 'ui-monospace, "Noto Sans Devanagari", monospace', label: 'Mono' },
]

const ASPECTS: Array<{ value: AspectId; label: string; hint: string }> = [
  { value: '9:16', label: '9:16', hint: 'Reels, Shorts' },
  { value: '4:5', label: '4:5', hint: 'Feed' },
  { value: '1:1', label: '1:1', hint: 'Square' },
  { value: '16:9', label: '16:9', hint: 'YouTube' },
]

const ACCENTS = ['#ffa83a', '#5fcdbb', '#ff7a5c', '#ffe14a', '#ffffff']

export function PropertiesPanel({ advanced }: { advanced: boolean }) {
  const tl = useEditor(headTimeline)
  const commit = useEditor((s) => s.commit)
  const dev = usePrefs((s) => s.captionDev)
  const setDev = usePrefs((s) => s.setCaptionDev)
  const brand = useBrand()
  const s = tl.settings
  const set = (patch: Parameters<typeof commit>[0] extends infer O ? O : never, label: string) =>
    commit(patch, { author: 'you', label })

  return (
    <div className="flex flex-col gap-6 pb-2">
      <section aria-labelledby="cap-h" className="flex flex-col gap-4">
        <h3 id="cap-h" className="text-sm font-semibold">
          Captions
        </h3>
        <Switch
          label="Show captions"
          checked={s.captionsOn}
          onCheckedChange={(v) =>
            set(
              { type: 'setSettings', patch: { captionsOn: v } },
              v ? 'Turned captions on' : 'Turned captions off',
            )
          }
        />
        <div role="radiogroup" aria-label="Caption style" className="grid grid-cols-2 gap-2.5">
          {CAPTION_STYLES.map((c) => (
            <StyleTile
              key={c.id}
              id={c.id}
              selected={s.captionStyleId === c.id}
              onPick={() => set({ type: 'setCaptionStyle', styleId: c.id }, `Captions: ${c.name}`)}
            />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted" id="script-l">
            Script
          </span>
          <div
            role="radiogroup"
            aria-labelledby="script-l"
            className="grid grid-cols-2 gap-1 rounded-full bg-surface-2 p-1"
          >
            {[
              [false, 'Roman'],
              [true, 'देवनागरी'],
            ].map(([v, label]) => (
              <button
                key={String(v)}
                type="button"
                role="radio"
                aria-checked={dev === v}
                onClick={() => setDev(v as boolean)}
                className={cn(
                  'rounded-full py-1.5 text-sm font-medium transition-colors',
                  dev === v ? 'bg-surface-1 text-text shadow-soft' : 'text-muted hover:text-text',
                )}
              >
                {label as string}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="look-h" className="flex flex-col gap-4">
        <h3 id="look-h" className="text-sm font-semibold">
          Look
        </h3>
        <Select
          label="Font"
          value={s.captionFont ?? ''}
          onValueChange={(v) =>
            set(
              { type: 'setSettings', patch: { captionFont: v || undefined } },
              'Changed caption font',
            )
          }
          options={FONTS}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted" id="accent-l">
            Highlight colour
          </span>
          <div
            role="radiogroup"
            aria-labelledby="accent-l"
            className="flex flex-wrap items-center gap-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!s.captionAccent}
              onClick={() =>
                set(
                  { type: 'setSettings', patch: { captionAccent: undefined } },
                  'Reset highlight colour',
                )
              }
              className={cn(
                'h-8 rounded-full border px-3 text-xs font-medium',
                !s.captionAccent ? 'border-saffron text-accent' : 'border-line text-muted',
              )}
            >
              Default
            </button>
            {[...new Set([...ACCENTS, brand.colors.primary, brand.colors.accent])].map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={s.captionAccent === c}
                aria-label={`Highlight colour ${c}`}
                onClick={() =>
                  set(
                    { type: 'setSettings', patch: { captionAccent: c } },
                    'Changed highlight colour',
                  )
                }
                className={cn(
                  'size-8 rounded-full border-2 transition-transform active:scale-90',
                  s.captionAccent === c ? 'border-text' : 'border-transparent',
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted" id="asp-l">
            Aspect ratio
          </span>
          <div role="radiogroup" aria-labelledby="asp-l" className="grid grid-cols-4 gap-1.5">
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={s.aspect === a.value}
                onClick={() =>
                  set({ type: 'setSettings', patch: { aspect: a.value } }, `Aspect ${a.value}`)
                }
                className={cn(
                  'flex flex-col items-center rounded-control border py-2 text-xs font-semibold transition-colors',
                  s.aspect === a.value
                    ? 'border-saffron bg-saffron-soft text-accent'
                    : 'border-line text-muted hover:bg-surface-2',
                )}
              >
                {a.label}
                <span className="mt-0.5 text-[10px] font-normal opacity-80">{a.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <Slider
          label="Zoom into the shot"
          value={s.crop.scale}
          min={1}
          max={2.5}
          step={0.05}
          display={`${s.crop.scale.toFixed(2)}x`}
          onCommit={(v) => set({ type: 'setCrop', crop: { ...s.crop, scale: v } }, 'Changed zoom')}
        />
      </section>

      {advanced && (
        <section aria-labelledby="kf-h" className="flex flex-col gap-3">
          <h3 id="kf-h" className="text-sm font-semibold">
            Reframing keyframes
          </h3>
          <p className="text-xs text-muted">
            Move the reel window over time. Set the window, then add a keyframe at the playhead. Add
            another elsewhere to animate between them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              leading={<Crosshair className="size-3.5" aria-hidden="true" />}
              onClick={() =>
                set(
                  {
                    type: 'setCrop',
                    crop: s.crop,
                    keyframes: [
                      ...s.keyframes.filter((k) => Math.abs(k.t - clock.time) > 0.2),
                      { ...s.crop, t: clock.time },
                    ].sort((a, b) => a.t - b.t),
                  },
                  'Added keyframe',
                )
              }
            >
              Add keyframe here
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!s.keyframes.length}
              leading={<Eraser className="size-3.5" aria-hidden="true" />}
              onClick={() =>
                set({ type: 'setCrop', crop: s.crop, keyframes: [] }, 'Cleared keyframes')
              }
            >
              Clear
            </Button>
          </div>
          {s.keyframes.length > 0 && (
            <ul className="space-y-1 text-xs text-muted">
              {s.keyframes.map((k) => (
                <li
                  key={k.t}
                  className="tnum flex justify-between rounded-lg bg-surface-2 px-3 py-1.5"
                >
                  <button
                    type="button"
                    className="font-medium text-text hover:underline"
                    onClick={() => clock.seek(k.t)}
                  >
                    {k.t.toFixed(1)}s
                  </button>
                  <span>
                    x {k.x.toFixed(2)} · zoom {k.scale.toFixed(2)}x
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
