import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import {
  Card,
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
      <div className="gradient-surface-content flex min-h-svh flex-col items-center justify-center bg-background px-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Подтверждение не требуется</CardTitle>
            <CardDescription>
              На сервере отключено подтверждение по почте. Перейдите ко входу или
              зарегистрируйтесь.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button className="w-full" asChild>
              <Link to="/login">Ко входу</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="gradient-surface-content flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Проверьте почту</CardTitle>
          <CardDescription className="space-y-2">
            <p>
              Мы отправили письмо с подтверждением. Обычно оно приходит в течение
              10 минут.
            </p>
            {email ? (
              <p className="font-mono text-sm text-foreground">{email}</p>
            ) : null}
            <p className="text-sm">
              Ссылка в письме откроет страницу подтверждения на этом сайте.
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
      </Card>
    </div>
  )
}
