import { Link } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet, SheetClose, SheetContent, SheetTrigger } from '@/components/ui/Sheet'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { useAuth } from '@/stores/auth'
import { DemoStrip } from './DemoStrip'
import { Hero } from './Hero'
import { Faq, FinalCta, Footer, HowItWorks, Pricing, WorksWith } from './Sections'
import { UspGrid } from './UspGrid'

const LINKS = [
  ['Features', '#features'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['FAQ', '#faq'],
] as const

export function LandingPage() {
  const user = useAuth((s) => s.user)
  return (
    <div>
      <a
        href="#top"
        className="sr-only z-[300] rounded-full bg-saffron px-4 py-2 font-semibold text-saffron-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" aria-label="Lypcut home" className="rounded-full">
            <Logo size={28} animated />
          </Link>
          <nav aria-label="Main" className="ml-6 hidden items-center gap-1 md:flex">
            {LINKS.map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded-full px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {user ? (
              <Button asChild size="sm" variant="primary">
                <Link to="/app">Open Lypcut</Link>
              </Button>
            ) : (
              <>
                <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
                  <Link to="/login">Log in</Link>
                </Button>
                <Button asChild size="sm" variant="primary">
                  <Link to="/signup">Start free</Link>
                </Button>
              </>
            )}
            <Sheet>
              <SheetTrigger asChild>
                <IconButton label="Open menu" variant="secondary" className="md:hidden">
                  <Menu className="size-4" aria-hidden="true" />
                </IconButton>
              </SheetTrigger>
              <SheetContent title="Menu" side="right">
                <nav aria-label="Mobile" className="flex flex-col gap-1">
                  {LINKS.map(([label, href]) => (
                    <SheetClose key={href} asChild>
                      <a
                        href={href}
                        className="rounded-xl px-3 py-3 text-lg font-medium hover:bg-surface-2"
                      >
                        {label}
                      </a>
                    </SheetClose>
                  ))}
                  <SheetClose asChild>
                    <Link
                      to="/login"
                      className="rounded-xl px-3 py-3 text-lg font-medium hover:bg-surface-2"
                    >
                      Log in
                    </Link>
                  </SheetClose>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main id="top">
        <Hero />
        <WorksWith />
        <DemoStrip />
        <UspGrid />
        <HowItWorks />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  )
}
