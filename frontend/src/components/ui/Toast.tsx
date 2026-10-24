import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { create } from 'zustand'
import { AiMark } from '@/components/brand/AiMark'
import { cn } from '@/lib/cn'

type Tone = 'success' | 'info' | 'error' | 'ai'

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: Tone
  actionLabel?: string
  onAction?: () => void
}

interface ToastState {
  toasts: ToastItem[]
  push: (t: Omit<ToastItem, 'id' | 'tone'> & { tone?: Tone; duration?: number }) => number
  dismiss: (id: number) => void
}

let nextId = 1

const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ duration = 4500, tone = 'info', ...rest }) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, ...rest }] }))
    if (duration > 0) setTimeout(() => get().dismiss(id), duration)
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Call from anywhere: toast({ title: 'Published', tone: 'success' }). */
export const toast = (t: Parameters<ToastState['push']>[0]) => useToastStore.getState().push(t)

const icons: Record<Exclude<Tone, 'ai'>, { icon: typeof Check; cls: string }> = {
  success: { icon: Check, cls: 'bg-teal-soft text-teal-text' },
  info: { icon: Info, cls: 'bg-saffron-soft text-accent' },
  error: { icon: AlertTriangle, cls: 'bg-danger-soft text-danger-text' },
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[200] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const meta = t.tone === 'ai' ? null : icons[t.tone]
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
              transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="glass pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card p-3.5 pr-2.5 sm:w-auto sm:min-w-72"
            >
              <span
                className={cn(
                  'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                  meta?.cls,
                )}
              >
                {meta ? <meta.icon className="size-4" aria-hidden="true" /> : <AiMark size={28} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{t.title}</p>
                {t.description && <p className="mt-0.5 text-[13px] text-muted">{t.description}</p>}
                {t.actionLabel && (
                  <button
                    type="button"
                    onClick={() => {
                      t.onAction?.()
                      dismiss(t.id)
                    }}
                    className="mt-1.5 text-[13px] font-semibold text-accent hover:underline"
                  >
                    {t.actionLabel}
                  </button>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="rounded-full p-1.5 text-faint hover:bg-surface-3 hover:text-text"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
