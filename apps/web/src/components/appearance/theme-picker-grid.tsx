import { useTranslations } from '@syrnike13/ui/i18n'
import { ThemePreviewSwatch } from '#/components/appearance/theme-preview-swatch'
import { readSystemPrefersDark } from '@syrnike13/ui/tokens'
import { useAppearance } from '#/features/appearance/appearance-context'

export function ThemePickerGrid() {
  const t = useTranslations('settings.appearance')
  const { settings, themes, setThemeId } = useAppearance()
  const prefersDark = readSystemPrefersDark()

  return (
    <div className="flex flex-col gap-2 pt-2">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('groups.solid')}
      </p>
      <div
        role="group"
        aria-label={t('groups.solid')}
        className="flex flex-wrap gap-2.5"
      >
        {themes.map((theme) => (
          <ThemePreviewSwatch
            key={theme.id}
            theme={theme}
            active={settings.themeId === theme.id}
            settings={settings}
            prefersDark={prefersDark}
            onSelect={() => setThemeId(theme.id)}
          />
        ))}
      </div>
    </div>
  )
}
