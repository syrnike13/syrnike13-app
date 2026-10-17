import { Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { ComponentProps, PropsWithChildren } from 'react'

import { HomeIcon } from '#/components/icons'
import { ShellTitleBar } from '#/components/layout/shell-title-bar'
import { Card } from '#/components/ui/card'
import { config as appConfig } from '#/lib/config'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'

export function AuthLayout({ children }: PropsWithChildren) {
  const { isDesktop } = usePlatform()
  const t = useTranslations('auth')

  return (
    <div className="auth-shell gradient-surface-content">
      {isDesktop ? <ShellTitleBar /> : null}
      <main className="auth-stage">
        <header className="auth-stage-header">
          {!isDesktop ? (
            <Link to="/" className="auth-home-link">
              <HomeIcon aria-hidden="true" />
              {t('home')}
            </Link>
          ) : null}
        </header>

        <div className="auth-stage-content">
          <div className="auth-centered">
            <div className="auth-brand">
              <img src="/app-logo.png" alt="" />
              <span>syrnike13</span>
            </div>
            {children}
          </div>
        </div>

        {appConfig.releaseChannel === 'nightly' ? (
          <div className="auth-environment">
            <span aria-hidden="true">🌙</span>
            nightly
          </div>
        ) : null}
      </main>
    </div>
  )
}

export function AuthCard({
  className,
  ...props
}: ComponentProps<typeof Card>) {
  return <Card className={cn('auth-card', className)} {...props} />
}
