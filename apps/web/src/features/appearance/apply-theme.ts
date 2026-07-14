import type { AppearanceSettings } from '@syrnike13/platform'

import {
  allThemeCssVariables,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
  resolveThemeVariant,
  type ThemeVariant,
} from '#/features/appearance/theme-registry'
import { allThemeSurfaceCssVariables } from '#/features/appearance/theme-surfaces'

export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined') return true
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyThemeToDocument(
  settings: AppearanceSettings,
  prefersDark = readSystemPrefersDark(),
) {
  if (typeof document === 'undefined') return resolveThemeVariant(settings, prefersDark)

  const variant = resolveThemeVariant(settings, prefersDark)
  const theme = getThemeById(settings.themeId)
  const tokens = getThemeTokens(settings, prefersDark)
  const root = document.documentElement

  root.classList.toggle('dark', variant === 'dark')
  root.dataset.theme = theme.id
  root.dataset.themeGradient =
    theme.kind === 'gradient'
      ? theme.customizable && settings.gradient
        ? 'custom'
        : 'preset'
      : 'none'

  const variables = {
    ...allThemeCssVariables(tokens),
    ...allThemeSurfaceCssVariables(
      getThemeSurfaceVariables(settings, prefersDark),
    ),
  }
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value)
  }

  return variant
}

export function resolvedVariantIsDark(variant: ThemeVariant): boolean {
  return variant === 'dark'
}
