import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import { LeapLoader } from '@/components/brand/LeapLoader'
import { AppShell } from './AppShell'
import { PublicOnly, RequireAuth, RequireUser } from './guards'
import { RouteError } from './RouteError'

/** Shown while a route chunk loads. Fixed height so nothing shifts when the page arrives. */
function RouteFallback() {
  return (
    <div className="grid min-h-[60dvh] place-items-center">
      <LeapLoader label="Loading page" />
    </div>
  )
}

/** Every page is its own chunk. `page` picks the named export from a dynamic import. */
function lazyPage<T extends Record<string, unknown>>(
  load: () => Promise<T>,
  name: keyof T,
): Pick<RouteObject, 'lazy' | 'HydrateFallback'> {
  return {
    lazy: async () => ({ Component: (await load())[name] as never }),
    HydrateFallback: RouteFallback,
  }
}

export const routes: RouteObject[] = [
  {
    path: '/',
    ...lazyPage(() => import('@/features/landing/LandingPage'), 'LandingPage'),
    errorElement: <RouteError />,
  },
  {
    element: <PublicOnly />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', ...lazyPage(() => import('@/features/auth/LoginPage'), 'LoginPage') },
      { path: '/signup', ...lazyPage(() => import('@/features/auth/SignupPage'), 'SignupPage') },
    ],
  },
  {
    element: <RequireUser />,
    errorElement: <RouteError />,
    children: [
      {
        path: '/onboarding',
        ...lazyPage(() => import('@/features/auth/OnboardingPage'), 'OnboardingPage'),
      },
    ],
  },
  {
    path: '/app',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            index: true,
            ...lazyPage(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage'),
          },
          {
            path: 'new',
            ...lazyPage(() => import('@/features/upload/NewProjectPage'), 'NewProjectPage'),
          },
          { path: 'style', ...lazyPage(() => import('@/features/style/StylePage'), 'StylePage') },
          {
            path: 'settings',
            ...lazyPage(() => import('@/features/settings/SettingsPage'), 'SettingsPage'),
          },
        ],
      },
      // The project page picks its own chrome: the editor needs the whole screen.
      {
        path: 'project/:id',
        ...lazyPage(() => import('@/features/project/ProjectPage'), 'ProjectPage'),
        // The export dialog opens over the editor, so it renders in the editor's <Outlet />.
        children: [
          {
            path: 'export',
            ...lazyPage(() => import('@/features/export/ExportDialog'), 'ExportDialog'),
          },
        ],
      },
    ],
  },
  {
    path: '/styleguide',
    ...lazyPage(() => import('@/pages/styleguide/StyleGuidePage'), 'StyleGuidePage'),
    errorElement: <RouteError />,
  },
  { path: '*', element: <Navigate to="/" replace /> },
]

export const router = createBrowserRouter(routes)
