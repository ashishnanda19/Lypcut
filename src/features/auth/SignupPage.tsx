import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/stores/auth'
import { AuthForm } from './AuthForm'
import { AuthLayout } from './AuthLayout'

export function SignupPage() {
  const signup = useAuth((s) => s.signup)
  const google = useAuth((s) => s.google)
  const navigate = useNavigate()
  return (
    <AuthLayout
      title="Make your first Reel today"
      subtitle="Free to start. No card needed."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-accent hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <AuthForm
        mode="signup"
        onSubmit={async (v) => {
          await signup(v.name, v.email, v.password)
          navigate('/onboarding', { replace: true })
        }}
        onGoogle={async () => {
          await google()
          navigate('/onboarding', { replace: true })
        }}
      />
    </AuthLayout>
  )
}
