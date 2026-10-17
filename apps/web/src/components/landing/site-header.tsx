import { Link } from '@tanstack/react-router'
import { Button } from '@syrnike13/ui/primitives/button'
import { useTranslations } from '@syrnike13/ui/i18n'

import { APP_LOGO_SRC } from '#/lib/brand'
import { config } from '#/lib/config'

export function SiteHeader() {
  const t = useTranslations('landing')

  return (
    <header className="relative z-10 mx-auto flex w-full max-w-300 items-center justify-between px-6 py-5">
      <Link to="/" className="flex items-center gap-2">
        <img
          src={APP_LOGO_SRC}
          alt=""
          className="size-7"
          width={28}
          height={28}
        />
        <span className="text-[0.9375rem] font-bold tracking-tight">
          {config.appTitle}
        </span>
      </Link>

      <Button asChild variant="inverse" size="sm" className="rounded-full px-4">
        <Link
          data-homage-anchor="header-cta"
          to="/app"
          search={{ tab: 'online' }}
        >
          {t('openInBrowser')}
        </Link>
      </Button>
    </header>
  )
}
