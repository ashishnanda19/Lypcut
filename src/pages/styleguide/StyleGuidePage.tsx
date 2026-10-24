import { Logo } from '@/components/brand/Logo'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { Controls } from './Controls'
import { Foundations } from './Foundations'
import { Product } from './Product'

const nav = [
  ['brand', 'Brand'],
  ['color', 'Colour'],
  ['type', 'Type'],
  ['controls', 'Controls'],
  ['status', 'Feedback'],
  ['chat', 'Chat'],
  ['transcript', 'Transcript'],
  ['timeline', 'Timeline'],
  ['reel', 'Phone'],
  ['cards', 'Clip cards'],
] as const

export function StyleGuidePage() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Logo size={28} animated />
          <nav
            aria-label="Sections"
            className="scroll-thin ml-2 hidden min-w-0 flex-1 gap-1 overflow-x-auto md:flex"
          >
            {nav.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto md:ml-0">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="pb-4 pt-14">
          <h1 className="max-w-2xl text-5xl font-bold leading-[1.03] tracking-[-0.045em] sm:text-6xl">
            Style guide
          </h1>
          <p className="mt-4 max-w-xl text-lg text-muted">
            Every building block of Lypcut, working. Try the controls, switch the theme, and check
            that Hindi and Hinglish look as good as English.
          </p>
        </div>
        <Foundations />
        <Controls />
        <Product />
      </main>
    </div>
  )
}
