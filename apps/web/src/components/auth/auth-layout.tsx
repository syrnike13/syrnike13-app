import { Link } from '@tanstack/react-router'
import type { ComponentProps, PropsWithChildren } from 'react'

import { HomeIcon } from '#/components/icons'
import { Card } from '#/components/ui/card'
import { config as appConfig } from '#/lib/config'
import { cn } from '#/lib/utils'
import { usePlatform } from '#/platform/use-platform'

export function AuthLayout({ children }: PropsWithChildren) {
  const { isDesktop } = usePlatform()

  return (
    <div className="auth-shell gradient-surface-content">
      <main className="auth-stage">
        <header className="auth-stage-header">
          {!isDesktop ? (
            <Link to="/" className="auth-home-link">
              <HomeIcon aria-hidden="true" />
              На главную
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
