import { MotionConfig } from 'framer-motion'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { Toaster } from '@/components/ui/Toast'
import { router } from './router'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* "user" turns transform animations off when the OS asks for reduced motion. */}
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  )
}
