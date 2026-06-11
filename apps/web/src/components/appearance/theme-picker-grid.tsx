import { ThemePreviewCard } from '#/components/appearance/theme-preview-card'
import { readSystemPrefersDark } from '#/features/appearance/apply-theme'
import { useAppearance } from '#/features/appearance/appearance-context'

export function ThemePickerGrid() {
  const { settings, themes, setThemeId } = useAppearance()
  const prefersDark = readSystemPrefersDark()

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {themes.map((theme) => (
        <ThemePreviewCard
          key={theme.id}
          theme={theme}
          active={settings.themeId === theme.id}
          settings={settings}
          prefersDark={prefersDark}
          onSelect={() => setThemeId(theme.id)}
        />
      ))}
    </div>
  )
}
