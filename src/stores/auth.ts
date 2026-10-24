import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ContentType, Lang, User } from '@/types'
import { api, ApiError, setSessionExpiredHandler } from '@/api/client'
import { queryClient } from '@/api/queryClient'
import { toast } from '@/components/ui/Toast'
import { isReal } from '@/lib/runtime'
import { runSignOut } from '@/lib/session'

interface AuthState {
  user: User | null
  /** True for an instant after the person chose to log out, so the route guard sends them home, not to the login form. */
  leaving: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  google: () => Promise<void>
  /** Checks the stored sign-in with the server and refreshes the user. A no-op against the mock. */
  hydrate: () => Promise<void>
  update: (patch: Partial<Pick<User, 'name' | 'language' | 'contentType'>>) => Promise<void>
  finishOnboarding: (patch: { language: Lang; contentType: ContentType | null }) => Promise<void>
  logout: () => void
}

/** Empties everything that belongs to the person who is leaving. */
function forget() {
  queryClient.clear()
  runSignOut()
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      leaving: false,
      login: async (email, password) => {
        const { user } = await api.post<{ user: User }>('/auth/login', { email, password })
        forget()
        set({ user, leaving: false })
      },
      signup: async (name, email, password) => {
        const { user } = await api.post<{ user: User }>('/auth/signup', { name, email, password })
        forget()
        set({ user, leaving: false })
      },
      google: async () => {
        const { user } = await api.post<{ user: User }>('/auth/google')
        set({ user })
      },
      hydrate: async () => {
        if (!isReal || !get().user) return
        try {
          const { user } = await api.get<{ user: User }>('/me')
          set({ user })
        } catch (e) {
          // Only a refused session ends the sign-in. A server that is down must not log anyone out.
          if (e instanceof ApiError && e.status === 401) set({ user: null })
        }
      },
      update: async (patch) => {
        const user = get().user
        if (!user) return
        if (!isReal) {
          set({ user: { ...user, ...patch } })
          return
        }
        const res = await api.patch<{ user: User }>('/me', patch)
        set({ user: res.user })
      },
      finishOnboarding: async (patch) => {
        const user = get().user
        if (!user) return
        if (!isReal) {
          set({ user: { ...user, ...patch, onboarded: true } })
          return
        }
        const res = await api.patch<{ user: User }>('/me', { ...patch, onboarded: true })
        set({ user: res.user })
      },
      logout: () => {
        // Tell the server so the refresh token dies with the session; the screen does not wait for it.
        if (isReal) void api.post('/auth/logout').catch(() => undefined)
        // The route guard clears the flag once it has sent the person home.
        set({ user: null, leaving: true })
        forget()
      },
    }),
    { name: 'lypcut-auth', version: 1, partialize: (s) => ({ user: s.user }) },
  ),
)

// A refresh the server refused means the session is over. Send the person to log in again.
setSessionExpiredHandler(() => {
  if (!useAuth.getState().user) return
  useAuth.setState({ user: null })
  forget()
  toast({ title: 'You were signed out', description: 'Log in again to continue.', tone: 'info' })
})

/** Greeting in the user's language. */
export function greeting(user: User | null): string {
  const name = user?.name.split(' ')[0] ?? 'there'
  if (user?.language === 'hi') return `नमस्ते, ${name}`
  if (user?.language === 'hinglish') return `Namaste, ${name}`
  return `Welcome back, ${name}`
}
