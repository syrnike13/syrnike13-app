import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { SparklesIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { useAuth } from '#/features/auth/auth-context'
import { config } from '#/lib/config'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const t = useTranslations('login')
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
      await Effect.runPromise(
        auth.mfaChallenge
          ? auth.submitMfaPassword(mfaPassword)
          : auth.login({ email, password }),
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('error'))
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
            <div className="text-base font-semibold">syrnike13 admin</div>
            {nightly ? (
              <div className="text-xs font-medium uppercase text-warning">
                Nightly
              </div>
            ) : null}
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-md border border-border bg-card p-5"
        >
          <h1 className="text-base font-semibold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {auth.mfaChallenge ? t('mfaSubtitle') : t('subtitle')}
          </p>

          <div className="mt-5 space-y-4">
            {auth.mfaChallenge ? (
              <div className="space-y-2">
                <Label htmlFor="mfa">{t('mfaLabel')}</Label>
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
                  <Label htmlFor="password">{t('password')}</Label>
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
              {submitting ? t('submitting') : t('submit')}
            </Button>

            {auth.mfaChallenge ? (
              <button
                type="button"
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
                onClick={() => auth.cancelMfa()}
              >
                {t('back')}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  )
}
