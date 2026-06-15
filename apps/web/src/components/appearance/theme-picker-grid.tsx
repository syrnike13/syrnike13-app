import { ThemePreviewCard } from '#/components/appearance/theme-preview-card'
import { Switch } from '#/components/ui/switch'
import { readSystemPrefersDark } from '#/features/appearance/apply-theme'
import { useAppearance } from '#/features/appearance/appearance-context'
import {
  EASTER_PALETTE_HINT,
  handlePaletteEasterNote,
} from '#/features/easter/easter-palette-melody'
import {
  easterModeStore,
  useEasterMode,
} from '#/features/easter/easter-mode-store'

export function ThemePickerGrid() {
  const { settings, themes, setThemeId } = useAppearance()
  const easterModeEnabled = useEasterMode()
  const prefersDark = readSystemPrefersDark()

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {themes.map((theme) => (
          <ThemePreviewCard
            key={theme.id}
            theme={theme}
            active={settings.themeId === theme.id}
            settings={settings}
            prefersDark={prefersDark}
            onSelect={() => setThemeId(theme.id)}
            onPlayNote={() => handlePaletteEasterNote(theme.id)}
          />
        ))}
      </div>

      <p className="text-sm text-muted-foreground">{EASTER_PALETTE_HINT}</p>

      {easterModeEnabled ? (
        <label className="flex min-h-12 items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2">
          <span className="text-sm font-medium">Пасхальный режим</span>
          <Switch
            checked={easterModeEnabled}
            aria-label="Пасхальный режим"
            onCheckedChange={(checked) => {
              easterModeStore.setEnabled(checked)
            }}
          />
        </label>
      ) : null}
    </div>
  )
}
