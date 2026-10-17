import { THEME_CATALOG, type ThemeDefinition } from './catalog'
import { generatePrismTokens, type PrismTuningPatch } from './prism'
import {
  BRAND_THEME_TOKENS,
  prismTokensToThemeTokens,
  THEME_TOKEN_KEYS,
  type ThemeTokens,
} from './tokens'
import { buildSolidThemeSurfaceVariables, type ThemeSurfaceVariables } from './surfaces'
import { DEFAULT_THEME_ID, type ThemeSettings, type ThemeVariant } from './types'

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

export function resolveThemeVariant(
  settings: ThemeSettings,
  prefersDark = false,
): ThemeVariant {
  if (settings.colorMode === 'system') {
    return prefersDark ? 'dark' : 'light'
  }
  return settings.colorMode
}

export function applyBrandLockedThemeTokens(
  tokens: ThemeTokens,
  variant: ThemeVariant,
): ThemeTokens {
  return { ...tokens, ...BRAND_THEME_TOKENS[variant] }
}

export function getThemeTokens(
  settings: ThemeSettings,
  prefersDark = false,
  tuning?: PrismTuningPatch,
): ThemeTokens {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  const prismTokens = generatePrismTokens(
    theme.anchors[variant],
    variant,
    tuning,
  )
  return applyBrandLockedThemeTokens(
    prismTokensToThemeTokens(prismTokens, variant),
    variant,
  )
}

export function getThemeSurfaceVariables(
  settings: ThemeSettings,
  prefersDark = false,
  tuning?: PrismTuningPatch,
): ThemeSurfaceVariables {
  return buildSolidThemeSurfaceVariables(
    getThemeTokens(settings, prefersDark, tuning),
  )
}

/** Theme picker preview uses the generated accent, before the brand override. */
export function themePreviewColors(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): ThemePreviewColors {
  const tokens = generatePrismTokens(theme.anchors[variant], variant)
  return {
    background: tokens['--background'],
    primary: tokens['--primary'],
    sidebar: tokens['--sidebar'],
  }
}

export function previewVariantForTheme(
  theme: ThemeDefinition,
  settings: ThemeSettings,
  prefersDark = false,
): ThemeVariant {
  if (settings.themeId === theme.id) {
    return resolveThemeVariant(settings, prefersDark)
  }
  return prefersDark ? 'dark' : 'light'
}

export function allThemeCssVariables(
  tokens: ThemeTokens,
): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const key of THEME_TOKEN_KEYS) {
    variables[`--${key}`] = tokens[key]
  }
  variables['--success'] = tokens['chart-3']
  variables['--warning'] = tokens['chart-2']
  variables['--scrim'] = 'color-mix(in oklab, black 55%, transparent)'
  variables['--on-scrim'] = 'oklch(1 0 0)'
  variables['--on-solid'] = 'oklch(1 0 0)'
  variables['--on-media'] = 'oklch(1 0 0)'
  variables['--media-backdrop'] = 'oklch(0 0 0)'
  return variables
}
