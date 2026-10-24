import { QueryClient } from '@tanstack/react-query'

/** One cache for the app. It lives here, not in App, so signing out can empty it. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
})
