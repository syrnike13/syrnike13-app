import type { AppearanceSettings } from '@syrnike13/platform'

import {
  allThemeCssVariables,
  getThemeById,
  getThemeTokens,
  resolveThemeVariant,
  type ThemeVariant,
} from '#/features/appearance/theme-registry'

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

  const variables = allThemeCssVariables(tokens)
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value)
  }

  return variant
}

export function resolvedVariantIsDark(variant: ThemeVariant): boolean {
  return variant === 'dark'
}
