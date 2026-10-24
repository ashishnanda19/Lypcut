import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, KeyRound, Lock, Mail, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { ApiError } from '@/api/client'
import { isReal } from '@/lib/runtime'

/** The backend's minimum, checked here first so the message appears beside the field before a round trip. */
export const MIN_PASSWORD = 8

export type AuthMode = 'login' | 'signup'

interface Props {
  mode: AuthMode
  onSubmit: (v: { name: string; email: string; password: string }) => Promise<void>
  onGoogle: () => Promise<void>
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Shared by login and signup. Checks on the client first, then shows the server's message beside the field it names. */
export function AuthForm({ mode, onSubmit, onGoogle }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState<'form' | 'google' | null>(null)
  const [errors, setErrors] = useState<{
    name?: string
    email?: string
    password?: string
    form?: string
  }>({})

  const run = async (kind: 'form' | 'google', fn: () => Promise<void>) => {
    setBusy(kind)
    setErrors({})
    try {
      await fn()
    } catch (e) {
      if (e instanceof ApiError && (e.field === 'email' || e.field === 'password'))
        setErrors({ [e.field]: e.message })
      else
        setErrors({
          form: e instanceof Error ? e.message : 'Something went wrong. Please try again.',
        })
      setBusy(null)
    }
  }

  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    const next: typeof errors = {}
    if (mode === 'signup' && !name.trim()) next.name = 'Tell us what to call you.'
    if (!EMAIL.test(email)) next.email = 'Enter a valid email, like aarav@gmail.com.'
    if (mode === 'signup' && password.length < MIN_PASSWORD)
      next.password = `Choose a password with at least ${MIN_PASSWORD} characters.`
    else if (mode === 'login' && !password) next.password = 'Enter your password.'
    setErrors(next)
    if (Object.keys(next).length) return
    void run('form', () => onSubmit({ name, email, password }))
  }

  return (
    <div>
      {!isReal && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="w-full"
            loading={busy === 'google'}
            disabled={busy !== null}
            leading={<KeyRound className="size-4" aria-hidden="true" />}
            onClick={() => void run('google', onGoogle)}
          >
            Continue with Google
          </Button>
          <div className="my-6 flex items-center gap-3 text-xs text-faint" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or use email
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {mode === 'signup' && (
          <Input
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Aarav Sharma"
            leading={<UserRound className="size-4" aria-hidden="true" />}
            error={errors.name}
          />
        )}
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="you@example.com"
          leading={<Mail className="size-4" aria-hidden="true" />}
          error={errors.email}
        />
        <Input
          label="Password"
          type={show ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : 'Your password'}
          leading={<Lock className="size-4" aria-hidden="true" />}
          hint={
            mode === 'login' && !isReal
              ? 'Preview: any email works with a password of 8+ characters.'
              : undefined
          }
          error={errors.password}
          trailing={
            <IconButton
              label={show ? 'Hide password' : 'Show password'}
              size="sm"
              onClick={() => setShow((s) => !s)}
            >
              {show ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </IconButton>
          }
        />
        {errors.form && (
          <p
            role="alert"
            className="rounded-control bg-danger-soft px-3.5 py-2.5 text-sm text-danger-text"
          >
            {errors.form}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy === 'form'}
          disabled={busy !== null}
          className="mt-1 w-full"
        >
          {mode === 'login' ? 'Log in' : 'Create account'}
        </Button>
      </form>
    </div>
  )
}
