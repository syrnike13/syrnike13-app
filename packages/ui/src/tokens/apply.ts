import type { ThemeDefinition } from './catalog'
import type { PrismTuningPatch } from './prism'
import {
  allThemeCssVariables,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
  resolveThemeVariant,
  type ThemeAnchorOverrides,
} from './registry'
import { allThemeSurfaceCssVariables } from './surfaces'
import { DEFAULT_THEME_ID, type ThemeSettings, type ThemeVariant } from './types'

export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined') return true
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Применяет тему к документу. `resolveTheme` позволяет выбрать определение
 * темы под конкретный вариант — например, разные темы для light и dark.
 */
export function applyThemeToDocument(
  settings: ThemeSettings,
  prefersDark = readSystemPrefersDark(),
  tuning?: PrismTuningPatch,
  anchors?: ThemeAnchorOverrides,
  resolveTheme?: (variant: ThemeVariant) => ThemeDefinition,
) {
  if (typeof document === 'undefined') return resolveThemeVariant(settings, prefersDark)

  const variant = resolveThemeVariant(settings, prefersDark)
  const theme =
    resolveTheme?.(variant) ??
    getThemeById(settings.themeId ?? DEFAULT_THEME_ID)
  const tokens = getThemeTokens(settings, prefersDark, tuning, anchors, theme)
  const root = document.documentElement

  root.classList.toggle('dark', variant === 'dark')
  root.style.colorScheme = variant
  root.dataset.stylePreset = 'prism'
  root.dataset.themeMode = settings.colorMode
  root.dataset.themeResolved = variant
  root.dataset.theme = theme.id
  root.dataset.themeGradient = 'none'

  const variables = {
    ...allThemeCssVariables(tokens),
    ...allThemeSurfaceCssVariables(
      getThemeSurfaceVariables(settings, prefersDark, tuning, anchors, theme),
    ),
  }
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value)
  }

  return variant
}
