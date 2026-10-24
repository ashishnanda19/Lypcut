import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/stores/auth'

/** Signed-in, finished onboarding. Otherwise send people where they need to go. */
export function RequireAuth() {
  const user = useAuth((s) => s.user)
  const location = useLocation()
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  if (!user.onboarded) return <Navigate to="/onboarding" replace />
  return <Outlet />
}

/** Signed in but onboarding not done. */
export function RequireUser() {
  const user = useAuth((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.onboarded) return <Navigate to="/app" replace />
  return <Outlet />
}

/** Login and signup: skip them when already signed in. */
export function PublicOnly() {
  const user = useAuth((s) => s.user)
  if (user?.onboarded) return <Navigate to="/app" replace />
  if (user) return <Navigate to="/onboarding" replace />
  return <Outlet />
}
