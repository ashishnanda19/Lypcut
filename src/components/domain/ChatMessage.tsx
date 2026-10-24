import type { ReactNode } from 'react'
import { AiMark } from '@/components/brand/AiMark'
import { AI } from '@/lib/config'
import { cn } from '@/lib/cn'

const DEVANAGARI = /[ऀ-ॿ]/

interface ChatMessageProps {
  /** Who wrote it. */
  from: 'ai' | 'user'
  /** Message text. For streaming, pass the partial text and set `streaming`. */
  text?: string
  streaming?: boolean
  /** The assistant is working but has not started writing. */
  thinking?: boolean
  /** Inline cards (Edit cards, question cards) shown under the bubble. */
  children?: ReactNode
  className?: string
}

export function ChatMessage({
  from,
  text,
  streaming,
  thinking,
  children,
  className,
}: ChatMessageProps) {
  const lang = text && DEVANAGARI.test(text) ? 'hi' : undefined

  if (from === 'user') {
    return (
      <div className={cn('flex justify-end', className)}>
        <p
          lang={lang}
          className="max-w-[85%] whitespace-pre-wrap rounded-[20px] rounded-br-md border border-saffron/25 bg-saffron-soft px-4 py-2.5 text-[15px] text-text"
        >
          {text}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex gap-3', className)} aria-busy={streaming || thinking || undefined}>
      <AiMark size={30} thinking={thinking || streaming} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">{AI.name}</span>
          {(text || streaming) && (
            <p
              lang={lang}
              className="max-w-[92%] whitespace-pre-wrap rounded-[20px] rounded-tl-md bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-text"
            >
              {text}
              {streaming && (
                <span
                  aria-hidden="true"
                  className="ml-1 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-saffron"
                />
              )}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}
