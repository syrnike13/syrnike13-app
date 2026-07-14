import type { AppearanceGradientSettings } from '@syrnike13/platform'

import type {
  ThemeTokenKey,
  ThemeTokens,
} from '#/features/appearance/theme-tokens'

export const THEME_SURFACE_VARIABLE_KEYS = [
  'theme-backdrop',
  'theme-surface-lowest',
  'theme-surface-app-frame',
  'theme-surface-navigation',
  'theme-surface-content',
  'theme-surface-chrome',
  'theme-surface-raised',
  'theme-surface-input',
  'theme-surface-highest',
  'theme-surface-floating',
] as const

export type ThemeSurfaceVariableKey =
  (typeof THEME_SURFACE_VARIABLE_KEYS)[number]
export type ThemeSurfaceVariables = Record<ThemeSurfaceVariableKey, string>

const SURFACE_TOKEN_KEYS = [
  'background',
  'card',
  'popover',
  'secondary',
  'muted',
  'accent',
  'input',
  'sidebar',
  'sidebar-primary',
  'sidebar-accent',
] as const satisfies readonly ThemeTokenKey[]

const GRADIENT_SURFACE_OPACITY = {
  dark: {
    background: 86,
    card: 68,
    popover: 76,
    secondary: 50,
    muted: 44,
    accent: 38,
    input: 46,
    sidebar: 70,
    'sidebar-primary': 52,
    'sidebar-accent': 40,
  },
  light: {
    background: 82,
    card: 74,
    popover: 82,
    secondary: 58,
    muted: 52,
    accent: 46,
    input: 54,
    sidebar: 76,
    'sidebar-primary': 60,
    'sidebar-accent': 48,
  },
} as const satisfies Record<
  'light' | 'dark',
  Record<(typeof SURFACE_TOKEN_KEYS)[number], number>
>

const TEXT_TOKEN_KEYS = [
  'foreground',
  'card-foreground',
  'popover-foreground',
  'secondary-foreground',
  'muted-foreground',
  'accent-foreground',
  'sidebar-foreground',
  'sidebar-primary-foreground',
  'sidebar-accent-foreground',
] as const satisfies readonly ThemeTokenKey[]

const BORDER_TOKEN_KEYS = [
  'border',
  'shell-divider',
  'sidebar-border',
] as const satisfies readonly ThemeTokenKey[]

const GRADIENT_BORDER_OPACITY = {
  dark: {
    border: 42,
    'shell-divider': 48,
    'sidebar-border': 46,
  },
  light: {
    border: 50,
    'shell-divider': 54,
    'sidebar-border': 52,
  },
} as const satisfies Record<
  'light' | 'dark',
  Record<(typeof BORDER_TOKEN_KEYS)[number], number>
>

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatDecimal(value: number): string {
  return Number(value.toFixed(4)).toString()
}

function mixColor(source: string, target: string, targetAmount: number): string {
  const amount = clamp(targetAmount, 0, 100)
  if (amount === 0) return source
  return `color-mix(in oklab, ${source} ${formatDecimal(100 - amount)}%, ${target} ${formatDecimal(amount)}%)`
}

function translucentSurface(source: string, opacity: number): string {
  return `color-mix(in oklab, ${source} ${formatDecimal(opacity)}%, transparent)`
}

export function themeGradientCss(gradient: AppearanceGradientSettings): string {
  const colors =
    gradient.colors.length === 1
      ? [gradient.colors[0]!, gradient.colors[0]!]
      : gradient.colors
  return `linear-gradient(${gradient.angle}deg, ${colors.join(', ')})`
}

function overlaySurface(
  overlayRgb: '0 0 0' | '255 255 255',
  opacity: number,
  backdrop: string,
): string {
  const alpha = formatDecimal(clamp(opacity, 0, 1))
  return `linear-gradient(rgb(${overlayRgb} / ${alpha}), rgb(${overlayRgb} / ${alpha})) fixed 0 0 / cover, ${backdrop} fixed 0 0 / cover`
}

function darkSurfaceOpacities(saturation: number) {
  const mixAmount = clamp((saturation - 50) / 50, 0, 1)
  return {
    lowest: 0.54 + mixAmount * 0.12,
    appFrame: 0.42 + mixAmount * 0.4 * 0.7,
    navigation: 0.54 + mixAmount * 0.12,
    content: 0.54 + mixAmount * 0.25,
    chrome: 0.68 + mixAmount * 0.2,
    raised: 0.42 + mixAmount * 0.4 * 0.7,
    input: 0.95 + mixAmount * 0.4 * 0.65,
    highest: 0.39 + mixAmount * 0.4 * 0.65,
    floating: 0.38 + mixAmount * 0.22,
  }
}

function lightSurfaceOpacities(saturation: number) {
  const mixAmount = clamp((saturation - 50) / 50, 0, 1)
  return {
    lowest: 0.14 + mixAmount * 0.65,
    appFrame: 0.14 + mixAmount * 0.5 * 0.65,
    navigation: 0.20 + mixAmount * 0.65,
    content: 0.54 + mixAmount * 0.24,
    chrome:  0.54 + mixAmount * 0.24,
    raised: 0.325 + mixAmount * 0.5 * 0.65,
    input: 0.95 * (0.8 + mixAmount * 0.2),
    highest: 0.95 * (0.8 + mixAmount * 0.2),
    floating: 0.80 + mixAmount * 0.25,
  }
}

export function buildThemeSurfaceVariables(
  gradient: AppearanceGradientSettings,
  variant: 'light' | 'dark',
): ThemeSurfaceVariables {
  const backdrop = themeGradientCss(gradient)
  const dark = variant === 'dark'
  const overlayRgb = dark ? '0 0 0' : '255 255 255'
  const opacities = dark
    ? darkSurfaceOpacities(gradient.saturation)
    : lightSurfaceOpacities(gradient.saturation)

  return {
    'theme-backdrop': backdrop,
    'theme-surface-lowest': overlaySurface(
      overlayRgb,
      opacities.lowest,
      backdrop,
    ),
    'theme-surface-app-frame': overlaySurface(
      overlayRgb,
      opacities.appFrame,
      backdrop,
    ),
    'theme-surface-navigation': overlaySurface(
      overlayRgb,
      opacities.navigation,
      backdrop,
    ),
    'theme-surface-content': overlaySurface(
      overlayRgb,
      opacities.content,
      backdrop,
    ),
    'theme-surface-chrome': overlaySurface(
      overlayRgb,
      opacities.chrome,
      backdrop,
    ),
    'theme-surface-raised': overlaySurface(
      overlayRgb,
      opacities.raised,
      backdrop,
    ),
    'theme-surface-input': overlaySurface(
      overlayRgb,
      opacities.input,
      backdrop,
    ),
    'theme-surface-highest': overlaySurface(
      overlayRgb,
      opacities.highest,
      backdrop,
    ),
    'theme-surface-floating': overlaySurface(
      overlayRgb,
      opacities.floating,
      backdrop,
    ),
  }
}

export function buildSolidThemeSurfaceVariables(
  tokens: ThemeTokens,
): ThemeSurfaceVariables {
  return {
    'theme-backdrop': tokens.background,
    'theme-surface-lowest': tokens.background,
    'theme-surface-app-frame': tokens.background,
    'theme-surface-navigation': tokens.background,
    'theme-surface-content': tokens.card,
    'theme-surface-chrome': tokens.card,
    'theme-surface-raised': tokens.card,
    'theme-surface-input': tokens.input,
    'theme-surface-highest': tokens.input,
    'theme-surface-floating': tokens.secondary,
  }
}

export function tintThemeTokensForGradient(
  tokens: ThemeTokens,
  gradient: AppearanceGradientSettings,
  variant: 'light' | 'dark',
): ThemeTokens {
  const resolved = { ...tokens }
  const anchorColor = gradient.colors[0]!
  const baseColor =
    variant === 'dark'
      ? `color-mix(in oklab, ${anchorColor} 14%, black)`
      : `color-mix(in oklab, ${anchorColor} 18%, white)`
  const textColor = variant === 'dark' ? 'white' : 'black'
  const baseAmount = clamp(gradient.saturation * 0.95135, 0, 80)
  const textAmount = clamp(gradient.saturation * 0.4054, 0, 30)
  const borderAmount = clamp(gradient.saturation * 0.0676, 0, 5)

  for (const key of SURFACE_TOKEN_KEYS) {
    resolved[key] = translucentSurface(
      mixColor(tokens[key], baseColor, baseAmount),
      GRADIENT_SURFACE_OPACITY[variant][key],
    )
  }
  for (const key of TEXT_TOKEN_KEYS) {
    resolved[key] = mixColor(tokens[key], textColor, textAmount)
  }
  for (const key of BORDER_TOKEN_KEYS) {
    resolved[key] = translucentSurface(
      mixColor(tokens[key], baseColor, borderAmount),
      GRADIENT_BORDER_OPACITY[variant][key],
    )
  }

  return resolved
}

export function allThemeSurfaceCssVariables(
  variables: ThemeSurfaceVariables,
): Record<string, string> {
  const cssVariables: Record<string, string> = {}
  for (const key of THEME_SURFACE_VARIABLE_KEYS) {
    cssVariables[`--${key}`] = variables[key]
  }
  return cssVariables
}
