import { ThemePreviewSwatch } from '#/components/appearance/theme-preview-swatch'
import { Badge } from '#/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { readSystemPrefersDark } from '#/features/appearance/apply-theme'
import { useAppearance } from '#/features/appearance/appearance-context'
import { CUSTOM_GRADIENT_CONTROLS_ENABLED } from '#/features/appearance/appearance-feature-flags'

export function ThemePickerGrid() {
  const { settings, themes, setThemeId } = useAppearance()
  const prefersDark = readSystemPrefersDark()
  const solidThemes = themes.filter((theme) => theme.kind === 'solid')
  const gradientThemes = themes.filter(
    (theme) =>
      theme.kind === 'gradient' &&
      (CUSTOM_GRADIENT_CONTROLS_ENABLED || !theme.customizable),
  )

  const groups = [
    { label: 'Обычные', themes: solidThemes, beta: false },
    { label: 'Градиентные', themes: gradientThemes, beta: true },
  ]

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex flex-col gap-6 pt-2">
        {groups.map((group) => (
          <section key={group.label} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
              </p>
              {group.beta ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      tabIndex={0}
                      aria-label="Бета: функционал находится в разработке"
                    >
                      БЕТА
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Функционал находится в разработке
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div
              role="group"
              aria-label={group.label}
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
