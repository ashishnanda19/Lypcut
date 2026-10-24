import { Link, useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { EmptyIllustration } from '@/components/ui/EmptyState'

/** Last line of defence for a route that threw. Never a blank screen. */
export function RouteError() {
  const error = useRouteError()
  const message = error instanceof Error ? error.message : 'Something unexpected happened.'
  return (
    <div role="alert" className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <EmptyIllustration />
        <h1 className="text-2xl font-bold tracking-tight">That cut did not land</h1>
        <p className="text-muted">{message}</p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button asChild variant="secondary">
            <Link to="/app">Go to projects</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
