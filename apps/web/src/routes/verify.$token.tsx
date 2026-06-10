import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Loader2Icon } from '#/components/icons'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { verifyAccount } from '#/features/api/account-api'
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
  const { token } = Route.useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<VerifyState>({ status: 'loading' })

  useEffect(() => {
    let active = true

    async function run() {
      try {
        const response = await verifyAccount(token)
        if (!active) return

        const ticket = response.ticket?.token
        if (ticket) {
          const loginResult = await auth.completeEmailVerification(ticket)
          clearPendingVerifyEmail()
          if (active) {
            setState({ status: 'success', hasTicket: true })
            void navigate({
              to: postLoginPath(loginResult?.needsOnboarding ?? false),
              replace: true,
            })
          }
          return
        }

        setState({ status: 'success', hasTicket: false })
        toast.success('Email подтверждён')
      } catch (error) {
        if (!active) return
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось подтвердить email',
        })
      }
    }

    void run()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на token
  }, [token])

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Подтверждение email</CardTitle>
          <CardDescription>
            {state.status === 'loading' && 'Проверяем ссылку из письма…'}
            {state.status === 'success' &&
              (state.hasTicket
                ? 'Вход выполнен, перенаправляем…'
                : 'Аккаунт подтверждён. Теперь можно войти.')}
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
              <Link to="/login">Перейти ко входу</Link>
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  )
}
