import { useTranslations } from '@syrnike13/ui/i18n'
import type { ThemeDefinition, ThemeVariant } from '@syrnike13/ui/tokens'
import { themePreviewColors } from '@syrnike13/ui/tokens'

import { MoonIcon, SunIcon } from '#/components/icons'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

function orbImage(theme: ThemeDefinition, variant: ThemeVariant): string {
  const colors = themePreviewColors(theme, variant)
  return colors.gradient !== 'none'
    ? colors.gradient
    : `radial-gradient(circle at 32% 26%, ${colors.primary} 0%, ${colors.background} 58%, ${colors.sidebar} 100%)`
}

export function ThemeOrb({
  theme,
  variant,
  className,
}: {
  theme: ThemeDefinition
  variant: ThemeVariant
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'block size-16 shrink-0 rounded-full bg-(image:--orb-image)',
        className,
      )}
      style={{ '--orb-image': orbImage(theme, variant) } as CSSVars}
    />
  )
}

/** Пара сфер без выбора — для предпросмотра темы в редакторе. */
export function ThemeOrbPair({
  theme,
  className,
}: {
  theme: ThemeDefinition
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-center gap-3', className)}>
      <ThemeOrb
        theme={theme}
        variant="light"
        className="ring-1 ring-border/60"
      />
      <ThemeOrb
        theme={theme}
        variant="dark"
        className="ring-1 ring-border/60"
      />
    </div>
  )
}

/**
 * Два слота темы: светлый (солнце) и тёмный (луна). Каждый выбирается отдельно,
 * поэтому тема может стоять только в одном варианте. Бейдж варианта показываем
 * только у выбранного слота.
 */
export function ThemeOrbSlots({
  theme,
  name,
  selected,
  onSelect,
}: {
  theme: ThemeDefinition
  name: string
  selected: Record<ThemeVariant, boolean>
  onSelect: (variant: ThemeVariant) => void
}) {
  const t = useTranslations('settings.appearance')

  return (
    <div className="flex items-center justify-center gap-4">
      {(['light', 'dark'] as const).map((variant) => {
        const active = selected[variant]
        const Icon = variant === 'light' ? SunIcon : MoonIcon
        return (
          /* eslint-disable-next-line design/no-lookalike -- слот темы: цветная сфера с бейджем варианта */
          <button
            key={variant}
            type="button"
            aria-pressed={active}
            aria-label={
              variant === 'light'
                ? t('themesSection.setLight', { name })
                : t('themesSection.setDark', { name })
            }
            className={cn(
              'group/orb pointer-events-auto relative rounded-full p-1 transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
              active ? 'ring-2 ring-primary' : 'ring-1 ring-border',
            )}
            onClick={() => onSelect(variant)}
          >
            <ThemeOrb
              theme={theme}
              variant={variant}
              className={cn(
                'transition-transform group-hover/orb:scale-105',
                active ? '' : 'opacity-85',
              )}
            />
            {active ? (
              <span
                aria-hidden
                data-slot="theme-variant-badge"
                className="absolute right-0 bottom-0 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm"
              >
                <Icon className="size-3" />
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
