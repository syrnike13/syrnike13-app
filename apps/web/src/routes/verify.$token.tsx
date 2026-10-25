import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Effect, Fiber } from 'effect'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { cn } from '#/lib/utils'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { verifyAccountEffect } from '#/features/api/account-api'
import { useAuth } from '#/features/auth/auth-context'
import { clearPendingVerifyEmail } from '#/lib/auth-verify-email'
import { postLoginPath } from '#/lib/auth-post-login-path'
import { loadSession } from '#/lib/session'
import { apiErrorMessage } from '#/lib/api/error-message'

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
              message: apiErrorMessage(error, t('verify.error')),
            })
          }),
        ),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // Один раз на token.
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
          <CardContent className="flex justify-center">
            <Spinner className="size-8 text-muted-foreground" />
          </CardContent>
        ) : null}
        {state.status !== 'loading' ? (
          <CardFooter className="flex flex-col gap-2">
            <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
              {t('verify.toLogin')}
            </Link>
          </CardFooter>
        ) : null}
      </AuthCard>
    </AuthLayout>
  )
}
