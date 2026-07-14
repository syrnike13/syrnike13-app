import { ThemePreviewCard } from '#/components/appearance/theme-preview-card'
import { readSystemPrefersDark } from '#/features/appearance/apply-theme'
import { useAppearance } from '#/features/appearance/appearance-context'

export function ThemePickerGrid() {
  const { settings, themes, setThemeId } = useAppearance()
  const prefersDark = readSystemPrefersDark()
  const solidThemes = themes.filter((theme) => theme.kind === 'solid')
  const gradientThemes = themes.filter((theme) => theme.kind === 'gradient')

  function renderThemes(themesToRender: typeof themes) {
    return themesToRender.map((theme) => (
      <ThemePreviewCard
        key={theme.id}
        theme={theme}
        active={settings.themeId === theme.id}
        settings={settings}
        prefersDark={prefersDark}
        onSelect={() => setThemeId(theme.id)}
      />
    ))
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Обычные</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {renderThemes(solidThemes)}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Градиентные</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {renderThemes(gradientThemes)}
        </div>
      </div>
    </div>
  )
}
