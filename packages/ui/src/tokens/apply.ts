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
import type { ThemeSettings } from './types'

export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined') return true
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyThemeToDocument(
  settings: ThemeSettings,
  prefersDark = readSystemPrefersDark(),
  tuning?: PrismTuningPatch,
  anchors?: ThemeAnchorOverrides,
) {
  if (typeof document === 'undefined') return resolveThemeVariant(settings, prefersDark)

  const variant = resolveThemeVariant(settings, prefersDark)
  const theme = getThemeById(settings.themeId)
  const tokens = getThemeTokens(settings, prefersDark, tuning, anchors)
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
      getThemeSurfaceVariables(settings, prefersDark, tuning, anchors),
    ),
  }
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value)
  }

  return variant
}
