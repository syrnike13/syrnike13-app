import { generatePrismTokens, type PrismAnchors } from './prism'
import { THEME_CATALOG, type ThemeDefinition } from './catalog'
import {
  prismTokensToThemeTokens,
  THEME_TOKEN_KEYS,
  type ThemeTokens,
} from './tokens'
import {
  buildThemeSurfaceVariables,
  type ThemeSurfaceVariables,
} from './surfaces'
import {
  DEFAULT_THEME_ID,
  type ThemeSettings,
  type ThemeVariant,
} from './types'

export type ThemePreviewColors = {
  background: string
  foreground: string
  card: string
  muted: string
  primary: string
  sidebar: string
  gradient: string
  frame: string
  panel: string
  navigation: string
}

export function getThemeById(themeId: string): ThemeDefinition {
  return (
    THEME_CATALOG.find((theme) => theme.id === themeId) ?? THEME_CATALOG[0]!
  )
}

export function listThemes(): ThemeDefinition[] {
  return THEME_CATALOG
}

export function resolveThemeVariant(
  settings: ThemeSettings,
  prefersDark = false,
): ThemeVariant {
  return settings.colorMode === 'system'
    ? prefersDark
      ? 'dark'
      : 'light'
    : settings.colorMode
}

/** App-wide overrides and per-theme gradients share Prism's exact anchor contract. */
export function resolveThemeAnchors(
  theme: ThemeDefinition,
  variant: ThemeVariant,
  settings: ThemeSettings,
): PrismAnchors {
  const anchors = theme.anchors[variant]
  return settings.gradient
    ? { ...anchors, gradient: settings.gradient }
    : anchors
}

export function getThemeTokens(
  settings: ThemeSettings,
  prefersDark = false,
  theme: ThemeDefinition = getThemeById(settings.themeId ?? DEFAULT_THEME_ID),
): ThemeTokens {
  const variant = resolveThemeVariant(settings, prefersDark)
  return prismTokensToThemeTokens(
    generatePrismTokens(resolveThemeAnchors(theme, variant, settings), variant),
    variant,
  )
}

export function getThemeSurfaceVariables(
  settings: ThemeSettings,
  prefersDark = false,
  theme?: ThemeDefinition,
): ThemeSurfaceVariables {
  return buildThemeSurfaceVariables(
    getThemeTokens(settings, prefersDark, theme),
  )
}

export function themePreviewColors(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): ThemePreviewColors {
  const tokens = getThemeTokens(
    { colorMode: variant },
    variant === 'dark',
    theme,
  )
  return {
    background: tokens.background,
    foreground: tokens.foreground,
    card: tokens.card,
    muted: tokens.muted,
    primary: tokens.primary,
    sidebar: tokens.sidebar,
    gradient: tokens['app-gradient'],
    frame: tokens['layer-frame'],
    panel: tokens['layer-panel'],
    navigation: tokens['layer-sidebar'],
  }
}

export function previewVariantForTheme(
  theme: ThemeDefinition,
  settings: ThemeSettings,
  prefersDark = false,
): ThemeVariant {
  return (settings.themeId ?? DEFAULT_THEME_ID) === theme.id
    ? resolveThemeVariant(settings, prefersDark)
    : prefersDark
      ? 'dark'
      : 'light'
}

export function allThemeCssVariables(
  tokens: ThemeTokens,
): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const key of THEME_TOKEN_KEYS) variables[`--${key}`] = tokens[key]
  variables['--scrim'] = 'color-mix(in oklab, black 55%, transparent)'
  variables['--on-scrim'] = 'oklch(1 0 0)'
  variables['--on-solid'] = 'oklch(1 0 0)'
  variables['--on-media'] = 'oklch(1 0 0)'
  variables['--media-backdrop'] = 'oklch(0 0 0)'
  return variables
}
