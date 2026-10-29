import type { ThemeTokens } from './tokens'

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
  'theme-surface-solid',
] as const

export type ThemeSurfaceVariableKey =
  (typeof THEME_SURFACE_VARIABLE_KEYS)[number]
export type ThemeSurfaceVariables = Record<ThemeSurfaceVariableKey, string>

/**
 * Desktop-facing surface contract. Prism owns the underlying colors; these
 * variables only assign Prism roles to the layers inherited from the shell.
 */
export function buildThemeSurfaceVariables(
  tokens: ThemeTokens,
): ThemeSurfaceVariables {
  return {
    'theme-backdrop':
      tokens['app-gradient'] === 'none'
        ? tokens.background
        : tokens['app-gradient'],
    'theme-surface-lowest': tokens['layer-frame'],
    'theme-surface-app-frame': tokens['layer-frame'],
    // Prism exposes a single navigation role; the server rail, title bar and
    // sidebars all use it, so the `sidebar` mix drives the shell chrome.
    'theme-surface-navigation': tokens['layer-sidebar'],
    'theme-surface-content': tokens['layer-panel'],
    'theme-surface-chrome': tokens['layer-panel'],
    'theme-surface-raised': tokens['layer-raised'],
    'theme-surface-input': tokens.input,
    'theme-surface-highest': tokens.secondary,
    'theme-surface-floating': tokens['surface-raised'],
    'theme-surface-solid': tokens.popover,
  }
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
