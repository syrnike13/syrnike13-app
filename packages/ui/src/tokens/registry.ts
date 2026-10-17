import { THEME_CATALOG, type ThemeDefinition } from './catalog'
import { cssColorToHex } from './color-conversion'
import {
  buildSolidThemeSurfaceVariables,
  buildThemeSurfaceVariables,
  tintThemeTokensForGradient,
  type ThemeSurfaceVariables,
} from './surfaces'
import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  type ThemeTokens,
} from './tokens'
import {
  DEFAULT_THEME_ID,
  type ThemeGradientSettings,
  type ThemeSettings,
  type ThemeVariant,
} from './types'

export type ThemePreviewColors = {
  background: string
  primary: string
  sidebar: string
}

export const DEFAULT_THEME_GRADIENT_SATURATION = 74
export const DEFAULT_THEME_GRADIENT_ANGLE = 0

function defaultThemeGradient(
  theme: ThemeDefinition,
  variant: ThemeVariant,
): ThemeGradientSettings {
  const configured = theme.gradients?.[variant]
  if (configured) {
    return {
      ...configured,
      colors: [...configured.colors],
    }
  }

  const tokens =
    theme.variants[variant] ??
    theme.variants[getAvailableVariants(theme)[0] ?? 'dark']!
  const first = cssColorToHex(tokens.primary) ?? '#5865F2'
  const second =
    cssColorToHex(variant === 'dark' ? tokens.foreground : tokens.background) ??
    (variant === 'dark' ? '#F4F4F5' : '#FFFFFF')

  return {
    colors: [first, second],
    angle: DEFAULT_THEME_GRADIENT_ANGLE,
    saturation: DEFAULT_THEME_GRADIENT_SATURATION,
  }
}

export function resolveThemeGradient(
  settings: ThemeSettings,
  prefersDark = false,
): ThemeGradientSettings {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  return theme.customizable && settings.gradient
    ? settings.gradient
    : defaultThemeGradient(theme, variant)
}

export function themeGradientForPreview(
  theme: ThemeDefinition,
  variant: ThemeVariant,
  customGradient?: ThemeGradientSettings | null,
): ThemeGradientSettings {
  return theme.customizable && customGradient
    ? customGradient
    : defaultThemeGradient(theme, variant)
}

export function themeUsesGradient(theme: ThemeDefinition): boolean {
  return theme.kind === 'gradient'
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
  settings: ThemeSettings,
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
  settings: ThemeSettings,
  prefersDark = false,
): ThemeTokens {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  const tokens = applyBrandLockedThemeTokens(theme.variants[variant]!, variant)
  if (!themeUsesGradient(theme)) return tokens

  return tintThemeTokensForGradient(
    tokens,
    resolveThemeGradient(settings, prefersDark),
    variant,
  )
}

export function getThemeSurfaceVariables(
  settings: ThemeSettings,
  prefersDark = false,
): ThemeSurfaceVariables {
  const theme = getThemeById(settings.themeId)
  const variant = resolveThemeVariant(settings, prefersDark)
  const tokens = getThemeTokens(settings, prefersDark)
  if (!themeUsesGradient(theme)) {
    return buildSolidThemeSurfaceVariables(tokens)
  }

  return buildThemeSurfaceVariables(
    resolveThemeGradient(settings, prefersDark),
    variant,
  )
}

/** Цвета превью в каталоге тем — из палитры темы, без brand-lock (чтобы палитры различались). */
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
      primary: fallbackTokens?.primary ?? syrnikeBaseTokens(variant).primary,
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
  settings: ThemeSettings,
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
  variables['--success'] = tokens['chart-3']
  variables['--warning'] = tokens['chart-2']
  variables['--scrim'] = 'color-mix(in oklab, black 55%, transparent)'
  variables['--on-scrim'] = 'oklch(1 0 0)'
  variables['--on-solid'] = 'oklch(1 0 0)'
  return variables
}
