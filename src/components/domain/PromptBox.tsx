import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Mic } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui/IconButton'
import { toast } from '@/components/ui/Toast'

export type PromptLanguage = 'hi' | 'hinglish' | 'en'

const langLabel: Record<PromptLanguage, string> = { hi: 'हिं', hinglish: 'Hinglish', en: 'EN' }
const langOrder: PromptLanguage[] = ['hinglish', 'hi', 'en']

interface PromptBoxProps {
  onSubmit: (text: string) => void
  suggestions?: string[]
  placeholder?: string
  disabled?: boolean
  language?: PromptLanguage
  onLanguageChange?: (l: PromptLanguage) => void
  className?: string
}

export function PromptBox({
  onSubmit,
  suggestions = [],
  placeholder = 'Tell me what to cut, find or fix…',
  disabled,
  language = 'hinglish',
  onLanguageChange,
  className,
}: PromptBoxProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the text, up to about six lines.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [value])

  const send = (text = value) => {
    const t = text.trim()
    if (!t || disabled) return
    onSubmit(t)
    setValue('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Hindi and other IMEs use Enter to confirm a composition; never send mid-composition.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const cycleLanguage = () => {
    const next = langOrder[(langOrder.indexOf(language) + 1) % langOrder.length]
    if (next) onLanguageChange?.(next)
  }

  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      {suggestions.length > 0 && (
        <ul
          className="scroll-thin -mx-1 flex list-none gap-2 overflow-x-auto px-1 pb-1"
          aria-label="Suggestions"
        >
          {suggestions.map((s) => (
            <li key={s} className="shrink-0">
              <button
                type="button"
                onClick={() => send(s)}
                disabled={disabled}
                className="rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-[13px] font-medium text-muted transition-[background-color,color,transform] duration-150 hover:border-saffron/50 hover:bg-saffron-soft hover:text-accent active:scale-[0.97] disabled:opacity-45"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-1.5 rounded-[26px] border border-line bg-surface-2 p-1.5 pl-4 transition-colors focus-within:border-saffron focus-within:bg-surface-1">
        <label htmlFor="prompt-input" className="sr-only">
          Message to your editing assistant
        </label>
        <textarea
          id="prompt-input"
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-[150px] min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] text-text placeholder:text-faint focus:outline-none"
        />
        <button
          type="button"
          onClick={cycleLanguage}
          aria-label={`Voice and typing language: ${langLabel[language]}. Change`}
          className="mb-1 h-8 shrink-0 rounded-full px-2.5 text-xs font-semibold text-muted hover:bg-surface-3 hover:text-text"
        >
          {langLabel[language]}
        </button>
        <IconButton
          label="Speak (coming soon)"
          size="lg"
          onClick={() =>
            toast({
              title: 'Voice input is coming soon',
              description: 'For now, type in Hindi, Hinglish or English.',
            })
          }
        >
          <Mic className="size-[18px]" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Send"
          variant="primary"
          size="lg"
          shortcut={['Enter']}
          disabled={!value.trim() || disabled}
          onClick={() => send()}
        >
          <ArrowUp className="size-5" strokeWidth={2.5} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  )
}
