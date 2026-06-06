import { Button } from '#/components/ui/button'
import { PlatformIcon } from '#/components/platform-icons'
import { APP_LOGO_SRC } from '#/lib/brand'
import { desktopDownloads, type DesktopPlatform } from '#/lib/config'

interface HeroSectionProps {
  platform: DesktopPlatform
  onSwitchPlatform: (p: DesktopPlatform) => void
}

const PLATFORM_ORDER: DesktopPlatform[] = ['windows', 'macos', 'linux']

export function HeroSection({ platform, onSwitchPlatform }: HeroSectionProps) {
  const current = desktopDownloads[platform]
  const others = PLATFORM_ORDER.filter((p) => p !== platform)

  return (
    <section className="flex flex-col items-center gap-8">
      <img
        src={APP_LOGO_SRC}
        alt=""
        className="size-20"
        width={80}
        height={80}
      />

      <div className="space-y-4">
        <h1 className="font-display text-[2.5rem] font-bold leading-[1.1] tracking-[-0.02em] sm:text-[2.75rem]">
          Создайте место,
          <br />
          где вы проводите время вместе
        </h1>
        <p className="text-[17px] leading-relaxed text-muted-foreground">
          Серверы, каналы, голосовые комнаты — всё как вы привыкли, только
          своё.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <Button size="lg" asChild className="h-[52px] gap-2.5 px-7 text-[15px]">
          <a href={current.url}>
            <PlatformIcon platform={platform} className="size-4" />
            Скачать для {current.label}
          </a>
        </Button>

        {others.length > 0 && (
          <p className="pt-1 text-sm text-muted-foreground">
            {others.map((p, i) => (
              <span key={p}>
                {i > 0 && ' · '}
                <button
                  type="button"
                  onClick={() => onSwitchPlatform(p)}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <PlatformIcon platform={p} className="size-3" />
                  {desktopDownloads[p].label}
                </button>
              </span>
            ))}
          </p>
        )}
      </div>
    </section>
  )
}
