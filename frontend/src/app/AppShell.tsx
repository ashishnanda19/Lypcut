import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { FolderOpen, LogOut, Plus, Settings, Sparkles, UserRound } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { cn } from '@/lib/cn'
import { useAuth } from '@/stores/auth'

const nav = [
  { to: '/app', label: 'Projects', icon: FolderOpen, end: true },
  { to: '/app/style', label: 'Style', icon: Sparkles, end: false },
  { to: '/app/settings', label: 'Settings', icon: Settings, end: false },
]

/** Top bar, mobile nav and skip link around any page. Pages that need the full screen (the editor) skip it. */
export function AppChrome({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()
  const [menu, setMenu] = useState(false)

  return (
    <div className="min-h-dvh pb-20 md:pb-0">
      <a
        href="#main"
        className="sr-only z-[300] rounded-full bg-saffron px-4 py-2 font-semibold text-saffron-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/app" aria-label="Lypcut home" className="rounded-full">
            <Logo size={28} />
          </Link>
          <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-full px-4 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-surface-3 text-text'
                      : 'text-muted hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              className="hidden sm:inline-flex"
              leading={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => navigate('/app/new')}
            >
              New project
            </Button>
            <ThemeToggle />
            <DropdownMenu open={menu} onOpenChange={setMenu}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Account menu"
                  className="rounded-full transition-transform active:scale-95"
                >
                  <Avatar name={user?.name ?? '?'} size={36} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
                <DropdownMenuItem
                  icon={<UserRound className="size-4" />}
                  onSelect={() => navigate('/app/settings')}
                >
                  Account and settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<Sparkles className="size-4" />}
                  onSelect={() => navigate('/app/style')}
                >
                  Style profile
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<LogOut className="size-4" />}
                  onSelect={() => {
                    logout()
                    navigate('/')
                  }}
                >
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {children}
      </main>

      {/* Phone navigation */}
      <nav
        aria-label="Main"
        className="glass fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-full px-2 py-1.5 md:hidden"
        style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
      >
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cn(
                'flex min-w-16 flex-col items-center gap-0.5 rounded-full px-3 py-1.5 text-[11px] font-medium',
                isActive ? 'bg-saffron-soft text-accent' : 'text-muted',
              )
            }
          >
            <n.icon className="size-5" aria-hidden="true" />
            {n.label}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => navigate('/app/new')}
          className="flex min-w-16 flex-col items-center gap-0.5 rounded-full bg-saffron px-3 py-1.5 text-[11px] font-semibold text-saffron-ink"
        >
          <Plus className="size-5" aria-hidden="true" />
          New
        </button>
      </nav>
    </div>
  )
}

export function AppShell() {
  return (
    <AppChrome>
      <Outlet />
    </AppChrome>
  )
}
