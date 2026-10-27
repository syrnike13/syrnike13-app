import type { AppearanceColorMode } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { ThemeDefinition } from '@syrnike13/ui/tokens'

import {
  ThemePreviewMini,
  ThemePreviewSplit,
} from '#/components/appearance/theme-preview-mini'
import { resolveThemeForVariant } from '#/features/appearance/appearance-themes'
import { useAppearance } from '#/features/appearance/appearance-context'
import { cn } from '#/lib/utils'

const MODES: AppearanceColorMode[] = ['system', 'light', 'dark']

export function ColorSchemeCards() {
  const t = useTranslations('settings.appearance')
  const { settings, setColorMode } = useAppearance()
  const themes: Record<'light' | 'dark', ThemeDefinition> = {
    light: resolveThemeForVariant(settings, 'light'),
    dark: resolveThemeForVariant(settings, 'dark'),
  }

  return (
    <div
      role="group"
      aria-label={t('displayMode')}
      className="grid gap-3 sm:grid-cols-3"
    >
      {MODES.map((mode) => {
        const active = settings.colorMode === mode
        return (
          /* eslint-disable-next-line design/no-lookalike -- карточка схемы: превью темы и подпись, а не кнопка-действие */
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            className={cn(
              'flex flex-col gap-2 rounded-lg border p-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
              active
                ? 'border-primary ring-2 ring-primary/20'
                : 'border-border hover:border-foreground/30',
            )}
            onClick={() => setColorMode(mode)}
          >
            {mode === 'system' ? (
              <ThemePreviewSplit
                lightTheme={themes.light}
                darkTheme={themes.dark}
              />
            ) : (
              <ThemePreviewMini theme={themes[mode]} variant={mode} />
            )}
            <span
              className={cn(
                'text-center text-sm',
                active
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {t(`modes.${mode}`)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
