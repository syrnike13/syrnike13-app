import type { AppearanceSettings } from '@syrnike13/platform'
import { DEFAULT_THEME_ID } from '@syrnike13/platform'

import { THEME_CATALOG, type ThemeDefinition, type ThemeVariant } from '#/features/appearance/theme-catalog-data'
import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  type ThemeTokens,
} from '#/features/appearance/theme-tokens'

export { BRAND_LOCKED_THEME_TOKEN_KEYS, THEME_CATALOG, THEME_TOKEN_KEYS }
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

function syrnikeBaseTokens(variant: ThemeVariant): ThemeTokens {
  return getThemeById(DEFAULT_THEME_ID).variants[variant]!
}

export function applyBrandLockedThemeTokens(
  tokens: ThemeTokens,
  variant: ThemeVariant,
): ThemeTokens {
  const base = syrnikeBaseTokens(variant)
  const resolved = { ...tokens }
  for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
    resolved[key] = base[key]
  }
  return resolved
}

export function getThemeTokens(
  settings: AppearanceSettings,
  prefersDark = false,
): ThemeTokens {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  return applyBrandLockedThemeTokens(theme.variants[variant]!, variant)
}

export function themePreviewColors(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): ThemePreviewColors {
  const tokens = theme.variants[variant]
  if (!tokens) {
    const fallback = getAvailableVariants(theme)[0]
    const fallbackTokens = fallback ? theme.variants[fallback] : null
    const resolved = fallbackTokens
      ? applyBrandLockedThemeTokens(fallbackTokens, fallback)
      : null
    return {
      background: resolved?.background ?? 'oklch(0.3 0 0)',
      primary: resolved?.primary ?? syrnikeBaseTokens(variant).primary,
      sidebar: resolved?.sidebar ?? 'oklch(0.25 0 0)',
    }
  }
  const resolved = applyBrandLockedThemeTokens(tokens, variant)
  return {
    background: resolved.background,
    primary: resolved.primary,
    sidebar: resolved.sidebar,
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
