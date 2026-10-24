import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ContentType, Lang, User } from '@/types'
import { api } from '@/api/client'

interface AuthState {
  user: User | null
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  google: () => Promise<void>
  update: (patch: Partial<Pick<User, 'name' | 'language' | 'contentType' | 'plan'>>) => void
  finishOnboarding: (patch: { language: Lang; contentType: ContentType | null }) => void
  logout: () => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      login: async (email, password) => {
        const { user } = await api.post<{ user: User }>('/auth/login', { email, password })
        set({ user })
      },
      signup: async (name, email, password) => {
        const { user } = await api.post<{ user: User }>('/auth/signup', { name, email, password })
        set({ user })
      },
      google: async () => {
        const { user } = await api.post<{ user: User }>('/auth/google')
        set({ user })
      },
      update: (patch) => {
        const user = get().user
        if (user) set({ user: { ...user, ...patch } })
      },
      finishOnboarding: (patch) => {
        const user = get().user
        if (user) set({ user: { ...user, ...patch, onboarded: true } })
      },
      logout: () => set({ user: null }),
    }),
    { name: 'lypcut-auth', version: 1 },
  ),
)

/** Greeting in the user's language. */
export function greeting(user: User | null): string {
  const name = user?.name.split(' ')[0] ?? 'there'
  if (user?.language === 'hi') return `नमस्ते, ${name}`
  if (user?.language === 'hinglish') return `Namaste, ${name}`
  return `Welcome back, ${name}`
}
