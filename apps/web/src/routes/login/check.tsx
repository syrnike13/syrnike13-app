import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'

import { AuthCard, AuthLayout } from '#/components/auth/auth-layout'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { cn } from '#/lib/utils'
import {
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
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
            <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
              {t('toLogin')}
            </Link>
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
          <Link to="/login" className={cn(buttonVariants(), 'w-full')}>
            {t('toLogin')}
          </Link>
          <Link
            to="/login/resend"
            className={cn(buttonVariants({ variant: 'ghost' }), 'w-full')}
          >
            {t('check.resend')}
          </Link>
        </CardFooter>
      </AuthCard>
    </AuthLayout>
  )
}
