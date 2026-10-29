import { THEME_CATALOG, type ThemeDefinition } from './catalog'
import {
  generatePrismTokens,
  type PrismAnchors,
  type PrismTuningPatch,
} from './prism'
import {
  prismTokensToThemeTokens,
  THEME_TOKEN_KEYS,
  type ThemeTokens,
} from './tokens'
import { buildSolidThemeSurfaceVariables, type ThemeSurfaceVariables } from './surfaces'
import { DEFAULT_THEME_ID, type ThemeSettings, type ThemeVariant } from './types'

export type ThemePreviewColors = {
  background: string
  foreground: string
  card: string
  muted: string
  primary: string
  sidebar: string
}

/** Anchors merged on top of the catalog theme; dev preview only. */
export type ThemeAnchorOverrides = Partial<
  Record<ThemeVariant, Partial<PrismAnchors>>
>

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

export function getThemeTokens(
  settings: ThemeSettings,
  prefersDark = false,
  tuning?: PrismTuningPatch,
  anchors?: ThemeAnchorOverrides,
  theme: ThemeDefinition = getThemeById(settings.themeId ?? DEFAULT_THEME_ID),
): ThemeTokens {
  const variant = resolveThemeVariant(settings, prefersDark)
  const prismTokens = generatePrismTokens(
    { ...theme.anchors[variant], ...anchors?.[variant] },
    variant,
    tuning,
  )
  return prismTokensToThemeTokens(prismTokens, variant)
}

export function getThemeSurfaceVariables(
  settings: ThemeSettings,
  prefersDark = false,
  tuning?: PrismTuningPatch,
  anchors?: ThemeAnchorOverrides,
  theme?: ThemeDefinition,
): ThemeSurfaceVariables {
  return buildSolidThemeSurfaceVariables(
    getThemeTokens(settings, prefersDark, tuning, anchors, theme),
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
    foreground: tokens['--foreground'],
    card: tokens['--card'],
    muted: tokens['--muted'],
    primary: tokens['--primary'],
    sidebar: tokens['--sidebar'],
  }
}

export function previewVariantForTheme(
  theme: ThemeDefinition,
  settings: ThemeSettings,
  prefersDark = false,
): ThemeVariant {
  if ((settings.themeId ?? DEFAULT_THEME_ID) === theme.id) {
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
