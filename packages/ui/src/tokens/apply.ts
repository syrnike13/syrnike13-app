import { applyPrismTheme } from './prism'
import type { ThemeDefinition } from './catalog'
import {
  allThemeCssVariables,
  getThemeById,
  getThemeTokens,
  resolveThemeAnchors,
  resolveThemeVariant,
} from './registry'
import {
  allThemeSurfaceCssVariables,
  buildThemeSurfaceVariables,
} from './surfaces'
import { DEFAULT_THEME_ID, type ThemeSettings } from './types'

export function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Prism owns generation and document application; Syrnike supplies layout aliases. */
export function applyThemeToDocument(
  settings: ThemeSettings,
  prefersDark = readSystemPrefersDark(),
  theme: ThemeDefinition = getThemeById(settings.themeId ?? DEFAULT_THEME_ID),
) {
  const variant = resolveThemeVariant(settings, prefersDark)
  if (typeof document === 'undefined') return variant

  const root = document.documentElement
  applyPrismTheme(
    root,
    {
      mode: settings.colorMode,
      light: resolveThemeAnchors(theme, 'light', settings),
      dark: resolveThemeAnchors(theme, 'dark', settings),
    },
    variant,
  )
  root.dataset.theme = theme.id
  // Preserve the desktop/CSS contract; Prism also sets data-prism-gradient.
  root.dataset.themeGradient = root.dataset.prismGradient ? 'prism' : 'none'

  const tokens = getThemeTokens(settings, prefersDark, theme)
  const variables = {
    ...allThemeCssVariables(tokens),
    ...allThemeSurfaceCssVariables(buildThemeSurfaceVariables(tokens)),
  }
  for (const [name, value] of Object.entries(variables))
    root.style.setProperty(name, value)
  return variant
}
