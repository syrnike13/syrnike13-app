import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { config } from '#/lib/config'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaPassword, setMfaPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (auth.session) {
      void navigate({ to: '/badges', replace: true })
    }
  }, [auth.session, navigate])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      if (auth.mfaChallenge) {
        await auth.submitMfaPassword(mfaPassword)
      } else {
        await auth.login({ email, password })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось войти')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">syrnike13 Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {config.releaseChannel === 'nightly'
              ? 'Nightly окружение'
              : 'Production окружение'}
          </p>
        </div>

        {auth.mfaChallenge ? (
          <div className="space-y-2">
            <Label htmlFor="mfa-password">Пароль 2FA</Label>
            <Input
              id="mfa-password"
              type="password"
              value={mfaPassword}
              onChange={(event) => setMfaPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Входим...' : 'Войти'}
        </Button>
      </form>
    </main>
  )
}
