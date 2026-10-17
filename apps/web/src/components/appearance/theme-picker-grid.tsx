import { useTranslations } from '@syrnike13/ui/i18n'
import { ThemePreviewSwatch } from '#/components/appearance/theme-preview-swatch'
import { Badge } from '@syrnike13/ui/primitives/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { readSystemPrefersDark } from '@syrnike13/ui/tokens'
import { useAppearance } from '#/features/appearance/appearance-context'
import { CUSTOM_GRADIENT_CONTROLS_ENABLED } from '#/features/appearance/appearance-feature-flags'

export function ThemePickerGrid() {
  const t = useTranslations('settings.appearance')
  const { settings, themes, setThemeId } = useAppearance()
  const prefersDark = readSystemPrefersDark()
  const solidThemes = themes.filter((theme) => theme.kind === 'solid')
  const gradientThemes = themes.filter(
    (theme) =>
      theme.kind === 'gradient' &&
      (CUSTOM_GRADIENT_CONTROLS_ENABLED || !theme.customizable),
  )

  const groups = [
    { id: 'solid', labelKey: 'groups.solid', themes: solidThemes, beta: false },
    {
      id: 'gradient',
      labelKey: 'groups.gradient',
      themes: gradientThemes,
      beta: true,
    },
  ]

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex flex-col gap-6 pt-2">
        {groups.map((group) => (
          <section key={group.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t(group.labelKey)}
              </p>
              {group.beta ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      tabIndex={0}
                      aria-label={t('betaAria')}
                    >
                      {t('beta')}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {t('betaTooltip')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div
              role="group"
              aria-label={t(group.labelKey)}
              className="flex flex-wrap gap-2.5"
            >
              {group.themes.map((theme) => (
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
          </section>
        ))}
      </div>
    </TooltipProvider>
  )
}
