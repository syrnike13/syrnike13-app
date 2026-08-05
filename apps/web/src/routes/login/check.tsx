import { createFileRoute, Link } from '@tanstack/react-router'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { Button } from '#/components/ui/button'
import {
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import {
  isEmailVerificationEnabled,
  useSyrnikeConfig,
} from '#/features/auth/use-syrnike-config'
import { getPendingVerifyEmail } from '#/lib/auth-verify-email'

export const Route = createFileRoute('/login/check')({
  component: CheckEmailPage,
})

function CheckEmailPage() {
  const configQuery = useSyrnikeConfig()
  const email = getPendingVerifyEmail()

  if (
    configQuery.isSuccess &&
    !isEmailVerificationEnabled(configQuery.data?.features)
  ) {
    return (
      <AuthLayout>
        <AuthCard>
          <CardHeader>
            <CardTitle>Подтверждение не требуется</CardTitle>
            <CardDescription>
              Можно сразу вернуться ко входу и продолжить.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
          </CardFooter>
        </AuthCard>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard>
        <CardHeader>
          <CardTitle>Проверьте почту</CardTitle>
          <CardDescription className="space-y-2">
            <p>
              Мы отправили письмо с подтверждением. Обычно оно приходит в течение
              10 минут.
            </p>
            {email ? (
              <p className="rounded-xl bg-muted px-4 py-3 font-mono text-sm text-foreground">
                {email}
              </p>
            ) : null}
            <p className="text-sm">
              Перейдите по ссылке в письме, чтобы завершить регистрацию.
            </p>
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col gap-2">
          <Button className="w-full" asChild>
            <Link to="/login">Ко входу</Link>
          </Button>
          <Button variant="ghost" className="w-full" asChild>
            <Link to="/login/resend">Отправить письмо снова</Link>
          </Button>
        </CardFooter>
      </AuthCard>
    </AuthLayout>
  )
}
