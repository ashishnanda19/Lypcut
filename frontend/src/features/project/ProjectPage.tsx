import { lazy, Suspense } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useProject } from '@/api/hooks'
import { LeapLoader } from '@/components/brand/LeapLoader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ApiError } from '@/api/client'
import { AppChrome } from '@/app/AppShell'
import { ProcessingView, UploadPausedView } from './ProcessingView'

const EditorPage = lazy(() => import('@/features/editor/EditorPage'))

function Loading() {
  return (
    <div className="grid min-h-[60dvh] place-items-center">
      <LeapLoader label="Opening project" />
    </div>
  )
}

/** One URL per project. What it shows depends on how far along the project is. */
export function ProjectPage() {
  const { id } = useParams()
  const { data: project, isPending, error, refetch } = useProject(id)

  if (isPending)
    return (
      <AppChrome>
        <Loading />
      </AppChrome>
    )
  if (error || !project) {
    const missing = error instanceof ApiError && error.status === 404
    return (
      <AppChrome>
        <EmptyState
          title={missing ? 'We could not find that project' : 'Could not open this project'}
          description={
            missing ? 'It may have been deleted.' : 'Check your connection and try again.'
          }
          action={
            missing ? (
              <Button asChild variant="primary">
                <Link to="/app">Back to projects</Link>
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void refetch()}>
                Try again
              </Button>
            )
          }
        />
      </AppChrome>
    )
  }
  if (project.status === 'uploading')
    return (
      <AppChrome>
        <UploadPausedView project={project} />
      </AppChrome>
    )
  if (project.status === 'processing' || project.status === 'failed')
    return (
      <AppChrome>
        <ProcessingView key={project.id} project={project} />
      </AppChrome>
    )
  return (
    <Suspense fallback={<Loading />}>
      <EditorPage project={project} />
    </Suspense>
  )
}
