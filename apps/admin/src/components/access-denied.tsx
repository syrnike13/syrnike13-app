import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { useAuth } from '#/features/auth/auth-context'

export function AccessDenied() {
  const t = useTranslations('common')
  const auth = useAuth()

  return (
    <div className="flex h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>{t('accessDeniedTitle')}</CardTitle>
          <CardDescription>{t('accessDeniedDescription')}</CardDescription>
        </CardHeader>
        {auth.session ? (
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => Effect.runFork(auth.logout())}
            >
              {t('logout')}
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  )
}
