import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { SparklesIcon } from '#/components/icons'
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
    if (auth.session) void navigate({ to: '/badges', replace: true })
  }, [auth.session, navigate])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      if (auth.mfaChallenge) await auth.submitMfaPassword(mfaPassword)
      else await auth.login({ email, password })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось войти')
    } finally {
      setSubmitting(false)
    }
  }

  const nightly = config.releaseChannel === 'nightly'

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <div className="admin-enter w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <SparklesIcon className="size-4" aria-hidden />
          </span>
          <div>
            <div className="text-[15px] font-semibold">syrnike13 admin</div>
            {nightly ? (
              <div className="text-[10px] font-medium uppercase text-warning">Nightly</div>
            ) : null}
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-md border border-border/70 bg-card p-5"
        >
          <h1 className="text-[15px] font-semibold">Вход</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {auth.mfaChallenge ? 'Пароль 2FA' : 'Аккаунт администратора'}
          </p>

          <div className="mt-5 space-y-4">
            {auth.mfaChallenge ? (
              <div className="space-y-2">
                <Label htmlFor="mfa">Пароль 2FA</Label>
                <Input
                  id="mfa"
                  type="password"
                  value={mfaPassword}
                  onChange={(e) => setMfaPassword(e.target.value)}
                  autoFocus
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
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Пароль</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Входим...' : 'Войти'}
            </Button>

            {auth.mfaChallenge ? (
              <button
                type="button"
                className="w-full text-center text-[13px] text-muted-foreground hover:text-foreground"
                onClick={() => auth.cancelMfa()}
              >
                Назад
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  )
}
