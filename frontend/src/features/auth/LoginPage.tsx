import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/stores/auth'
import { AuthForm } from './AuthForm'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  const login = useAuth((s) => s.login)
  const google = useAuth((s) => s.google)
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from
  const done = () => navigate(from && from.startsWith('/app') ? from : '/app', { replace: true })
  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to pick up where you left off."
      footer={
        <>
          New to Lypcut?{' '}
          <Link to="/signup" className="font-semibold text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <AuthForm
        mode="login"
        onSubmit={async (v) => {
          await login(v.email, v.password)
          done()
        }}
        onGoogle={async () => {
          await google()
          done()
        }}
      />
    </AuthLayout>
  )
}
