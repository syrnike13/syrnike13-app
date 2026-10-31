import {
  getThemeById,
  getThemeTokens,
  THEME_TOKEN_KEYS,
  type ThemeSettings,
  type ThemeTokenKey,
} from '@syrnike13/ui/tokens'
import { Uniwind } from 'uniwind'

// Desktop-only tokens: CSS gradients and scrollbars have no native equivalent yet.
const SKIPPED_TOKENS = new Set<ThemeTokenKey>([
  'app-gradient',
  'scrollbar-thumb',
  'scrollbar-thumb-hover',
  'shell-divider',
])

/** Writes the user's Prism theme into both Uniwind variants; light/dark follow `colorMode`. */
export function applyTheme(settings: ThemeSettings) {
  const theme = getThemeById(settings.themeId ?? '')
  for (const variant of ['light', 'dark'] as const) {
    const tokens = getThemeTokens(
      { ...settings, colorMode: variant },
      variant === 'dark',
      theme,
    )
    const variables: Record<string, string> = {}
    for (const key of THEME_TOKEN_KEYS) {
      if (!SKIPPED_TOKENS.has(key)) variables[`--color-${key}`] = tokens[key]
    }
    Uniwind.updateCSSVariables(variant, variables)
  }
  Uniwind.setTheme(settings.colorMode)
}
