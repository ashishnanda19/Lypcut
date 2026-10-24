import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { PhoneFrame } from '@/components/domain/PhoneFrame'
import { PlaceholderThumb } from '@/components/domain/PlaceholderThumb'
import { Decorative } from '@/components/ui/Decorative'
import { AI } from '@/lib/config'

const POINTS = [
  'Chat in Hindi, Hinglish or English',
  'Every AI change is a card you can undo',
  'Export Reels, or the whole timeline to your editor',
]

/** Two columns: the form, and a quiet product panel on large screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <Link to="/" aria-label="Lypcut home" className="rounded-full">
            <Logo size={28} />
          </Link>
          <ThemeToggle />
        </div>
        <main
          id="main"
          className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10"
        >
          <h1 className="text-3xl font-bold tracking-[-0.035em]">{title}</h1>
          <p className="mt-2 text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <p className="mt-6 text-center text-sm text-muted">{footer}</p>
        </main>
      </div>
      <aside
        aria-label="About Lypcut"
        className="relative hidden overflow-hidden border-l border-line bg-surface-1 lg:block"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-10 size-96 rounded-full bg-saffron/15 blur-[100px]" />
          <div className="absolute bottom-0 right-0 size-96 rounded-full bg-teal/15 blur-[100px]" />
        </div>
        <div className="relative flex h-full flex-col items-center justify-center gap-10 p-12">
          <Decorative>
            <PhoneFrame width={210}>
              <PlaceholderThumb seed="auth-hero" aspect="reel" className="size-full" />
            </PhoneFrame>
          </Decorative>
          <div className="max-w-sm">
            <p className="text-2xl font-semibold tracking-tight">
              Tell {AI.name} what to cut. Watch the Reel take shape.
            </p>
            <ul className="mt-5 space-y-3">
              {POINTS.map((p) => (
                <li key={p} className="flex gap-3 text-[15px] text-muted">
                  <Check className="mt-0.5 size-4 shrink-0 text-teal-text" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
    </div>
  )
}
