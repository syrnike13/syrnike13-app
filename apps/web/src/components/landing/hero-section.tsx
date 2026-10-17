import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { cn } from '#/lib/utils'
import { useTranslations } from '@syrnike13/ui/i18n'

import { PlatformIcon } from '#/components/platform-icons'
import { APP_LOGO_SRC, APP_NAME } from '#/lib/brand'
import { desktopDownloads, type DesktopPlatform } from '#/lib/config'

interface HeroSectionProps {
  platform: DesktopPlatform
  onSwitchPlatform: (p: DesktopPlatform) => void
}

const PLATFORM_ORDER: DesktopPlatform[] = ['windows', 'macos', 'linux']

export function HeroSection({ platform, onSwitchPlatform }: HeroSectionProps) {
  const t = useTranslations('landing')
  const current = desktopDownloads[platform]
  const others = PLATFORM_ORDER.filter((p) => p !== platform)

  return (
    <section
      data-homage-anchor="hero"
      className="flex w-full max-w-[20rem] flex-col items-center"
    >
      {/* Визуальный центр — бренд, не текст */}
      <div className="flex flex-col items-center gap-5">
        <img
          data-homage-anchor="logo"
          src={APP_LOGO_SRC}
          alt=""
          className="size-[7.5rem]"
          width={120}
          height={120}
        />
        <div className="flex flex-col items-center gap-1.5">
          <p className="font-display text-[2rem] font-bold leading-none tracking-[-0.04em]">
            {APP_NAME}
          </p>
          <p className="text-sm text-muted-foreground">{t('tagline')}</p>
        </div>
      </div>

      {/* Действие — вторая точка тяжести */}
      <div className="mt-14 flex w-full flex-col items-center gap-4">
        <a
          data-homage-anchor="download"
          href={current.url}
          className={cn(
            buttonVariants({ size: 'lg' }),
            'h-14 w-full gap-2.5 text-[0.9375rem] font-semibold',
          )}
        >
          <PlatformIcon platform={platform} className="size-4" />
          {t('downloadFor', { platform: current.label })}
        </a>

        {others.length > 0 && (
          <div
            data-homage-anchor="platforms"
            className="flex items-center gap-2"
          >
            {others.map((p) => (
              <Button
                key={p}
                type="button"
                variant="outline-ghost"
                size="xs"
                onClick={() => onSwitchPlatform(p)}
                className="gap-1.5 rounded-full"
              >
                <PlatformIcon platform={p} className="size-3" />
                {desktopDownloads[p].label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
