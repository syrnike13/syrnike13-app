import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { useTranslations } from '@syrnike13/ui/i18n'

import { WindowsIcon } from '#/components/icons'
import { APP_LOGO_SRC, APP_NAME } from '#/lib/brand'
import { desktopDownload } from '#/lib/config'
import { cn } from '#/lib/utils'

export function HeroSection() {
  const t = useTranslations('landing')

  return (
    <section
      data-homage-anchor="hero"
      className="flex w-full max-w-80 flex-col items-center"
    >
      {/* Визуальный центр — бренд, не текст */}
      <div className="flex flex-col items-center gap-5">
        <img
          data-homage-anchor="logo"
          src={APP_LOGO_SRC}
          alt=""
          className="size-30"
          width={120}
          height={120}
        />
        <div className="flex flex-col items-center gap-1.5">
          <p className="font-display text-3xl font-bold leading-none tracking-tighter">
            {APP_NAME}
          </p>
          <p className="text-sm text-muted-foreground">{t('tagline')}</p>
        </div>
      </div>

      {/* Действие — вторая точка тяжести */}
      <a
        data-homage-anchor="download"
        href={desktopDownload.url}
        className={cn(buttonVariants({ size: 'xl' }), 'mt-14 w-full')}
      >
        <WindowsIcon className="size-4" />
        {t('downloadFor', { platform: desktopDownload.label })}
      </a>
    </section>
  )
}
