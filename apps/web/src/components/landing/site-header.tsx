import { Link } from '@tanstack/react-router'
// design-allow-file restyle-shared: landing marketing CTAs use brand pill buttons.
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { useTranslations } from '@syrnike13/ui/i18n'

import { APP_LOGO_SRC } from '#/lib/brand'
import { config } from '#/lib/config'
import { cn } from '#/lib/utils'

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
        <span className="text-base font-bold tracking-tight">
          {config.appTitle}
        </span>
      </Link>

      <Link
        data-homage-anchor="header-cta"
        to="/app"
        search={{ tab: 'online' }}
        className={cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          'rounded-full px-4',
        )}
      >
        {t('openInBrowser')}
      </Link>
    </header>
  )
}
