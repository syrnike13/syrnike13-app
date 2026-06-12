import type { AppearanceSettings } from '@syrnike13/platform'
import { DEFAULT_THEME_ID } from '@syrnike13/platform'

import { THEME_CATALOG, type ThemeDefinition, type ThemeVariant } from '#/features/appearance/theme-catalog-data'
import { THEME_TOKEN_KEYS, type ThemeTokens } from '#/features/appearance/theme-tokens'

export { THEME_CATALOG, THEME_TOKEN_KEYS }
export type { ThemeDefinition, ThemeTokens, ThemeVariant }

export type ThemePreviewColors = {
  background: string
  primary: string
  sidebar: string
}

export function getThemeById(themeId: string): ThemeDefinition {
  return (
    THEME_CATALOG.find((theme) => theme.id === themeId) ??
    THEME_CATALOG.find((theme) => theme.id === DEFAULT_THEME_ID)!
  )
}

export function listThemes(): ThemeDefinition[] {
  return THEME_CATALOG
}

export function themeHasVariant(theme: ThemeDefinition, variant: ThemeVariant): boolean {
  return Boolean(theme.variants[variant])
}

export function themeSupportsColorMode(theme: ThemeDefinition): boolean {
  return themeHasVariant(theme, 'light') && themeHasVariant(theme, 'dark')
}

export function getAvailableVariants(theme: ThemeDefinition): ThemeVariant[] {
  const variants: ThemeVariant[] = []
  if (themeHasVariant(theme, 'light')) variants.push('light')
  if (themeHasVariant(theme, 'dark')) variants.push('dark')
  return variants
}

export function resolveSystemVariant(
  prefersDark: boolean,
  theme: ThemeDefinition,
): ThemeVariant {
  if (prefersDark && themeHasVariant(theme, 'dark')) return 'dark'
  if (!prefersDark && themeHasVariant(theme, 'light')) return 'light'
  return getAvailableVariants(theme)[0] ?? 'dark'
}

export function resolveThemeVariant(
  settings: AppearanceSettings,
  prefersDark = false,
): ThemeVariant {
  const theme = getThemeById(settings.themeId)
  const available = getAvailableVariants(theme)
  if (available.length === 1) return available[0]!

  if (settings.colorMode === 'system') {
    return resolveSystemVariant(prefersDark, theme)
  }
  if (settings.colorMode === 'light' && themeHasVariant(theme, 'light')) {
    return 'light'
  }
  if (settings.colorMode === 'dark' && themeHasVariant(theme, 'dark')) {
    return 'dark'
  }
  return resolveSystemVariant(prefersDark, theme)
}

export function getThemeTokens(
  settings: AppearanceSettings,
  prefersDark = false,
): ThemeTokens {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  return theme.variants[variant]!
}

export function themePreviewColors(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): ThemePreviewColors {
  const tokens = theme.variants[variant]
  if (!tokens) {
    const fallback = getAvailableVariants(theme)[0]
    const fallbackTokens = fallback ? theme.variants[fallback] : null
    return {
      background: fallbackTokens?.background ?? 'oklch(0.3 0 0)',
      primary: fallbackTokens?.primary ?? 'oklch(0.6 0.2 280)',
      sidebar: fallbackTokens?.sidebar ?? 'oklch(0.25 0 0)',
    }
  }
  return {
    background: tokens.background,
    primary: tokens.primary,
    sidebar: tokens.sidebar,
  }
}

export function previewVariantForTheme(
  theme: ThemeDefinition,
  settings: AppearanceSettings,
  prefersDark = false,
): ThemeVariant {
  if (settings.themeId === theme.id) {
    return resolveThemeVariant(settings, prefersDark)
  }
  const available = getAvailableVariants(theme)
  if (available.includes('dark')) return 'dark'
  return available[0] ?? 'dark'
}

export function allThemeCssVariables(tokens: ThemeTokens): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const key of THEME_TOKEN_KEYS) {
    variables[`--${key}`] = tokens[key]
  }
  return variables
}
