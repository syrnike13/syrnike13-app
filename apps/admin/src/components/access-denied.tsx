import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Button } from '@syrnike13/ui/primitives/button'
import { useAuth } from '#/features/auth/auth-context'

export function AccessDenied() {
  const t = useTranslations('common')
  const auth = useAuth()

  return (
    <div className="flex h-svh items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-md border border-border bg-card p-6 text-center">
        <h1 className="text-base font-semibold">{t('accessDeniedTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('accessDeniedDescription')}
        </p>
        {auth.session ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => Effect.runFork(auth.logout())}
          >
            {t('logout')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
