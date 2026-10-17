import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'

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
  const t = useTranslations('auth')
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
            <CardTitle>{t('check.notRequiredTitle')}</CardTitle>
            <CardDescription>
              {t('check.notRequiredDescription')}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button className="w-full" asChild>
              <Link to="/login">{t('toLogin')}</Link>
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
          <CardTitle>{t('check.title')}</CardTitle>
          <CardDescription className="space-y-2">
            <p>{t('check.sent')}</p>
            {email ? (
              <p className="rounded-xl bg-muted px-4 py-3 font-mono text-sm text-foreground">
                {email}
              </p>
            ) : null}
            <p className="text-sm">{t('check.followLink')}</p>
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col gap-2">
          <Button className="w-full" asChild>
            <Link to="/login">{t('toLogin')}</Link>
          </Button>
          <Button variant="ghost" className="w-full" asChild>
            <Link to="/login/resend">{t('check.resend')}</Link>
          </Button>
        </CardFooter>
      </AuthCard>
    </AuthLayout>
  )
}
