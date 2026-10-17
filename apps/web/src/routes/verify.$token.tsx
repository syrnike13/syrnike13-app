import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Loader2Icon } from '#/components/icons'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { Button } from '#/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { verifyAccountEffect } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { clearPendingVerifyEmail } from '#/lib/auth-verify-email'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/verify/$token')({
  beforeLoad: () => {
    if (typeof window !== 'undefined' && loadSession()) {
      return
    }
  },
  component: VerifyEmailPage,
})

type VerifyState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; hasTicket: boolean }

function VerifyEmailPage() {
  const t = useTranslations('auth')
  const { token } = Route.useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<VerifyState>({ status: 'loading' })

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.gen(function*() {
        const response = yield* verifyAccountEffect(token)
        const ticket = response?.ticket.token
        if (!ticket) {
          yield* Effect.sync(() => {
            setState({ status: 'success', hasTicket: false })
            toast.success(t('verify.successTitle'))
          })
          return
        }

        const loginResult = yield* auth.completeEmailVerification(ticket)
        yield* Effect.sync(() => {
          clearPendingVerifyEmail()
          setState({ status: 'success', hasTicket: true })
        })
        yield* Effect.tryPromise({
          try: () =>
            navigate({
              to: postLoginPath(loginResult?.needsOnboarding ?? false),
              replace: true,
            }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            setState({
              status: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : t('verify.error'),
            })
          }),
        ),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на token
  }, [token])

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>
            {state.status === 'loading' && t('verify.loadingTitle')}
            {state.status === 'success' && t('verify.successTitle')}
            {state.status === 'error' && t('verify.errorTitle')}
          </CardTitle>
          <CardDescription>
            {state.status === 'loading' && t('verify.loadingDescription')}
            {state.status === 'success' &&
              (state.hasTicket
                ? t('verify.successTicket')
                : t('verify.successNoTicket'))}
            {state.status === 'error' && state.message}
          </CardDescription>
        </CardHeader>
        {state.status === 'loading' ? (
          <CardContent className="flex justify-center py-6">
            <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
          </CardContent>
        ) : null}
        {state.status !== 'loading' ? (
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" asChild>
              <Link to="/login">{t('verify.toLogin')}</Link>
            </Button>
          </CardFooter>
        ) : null}
      </AuthCard>
    </AuthLayout>
  )
}
