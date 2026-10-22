import { Navigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Spinner } from '@syrnike13/ui/primitives/spinner'

import { useAuth } from './auth-context'

export function AuthedGate({ children }: { children: ReactNode }) {
  const t = useTranslations('common')
  const auth = useAuth()

  if (!auth.hydrated || auth.isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Spinner className="size-4" aria-hidden />
        {t('loading')}
      </div>
    )
  }

  if (!auth.session) {
    return <Navigate to="/login" replace />
  }

  return children
}
