import { describe, expect, it } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  THEME_SURFACE_VARIABLE_KEYS,
  allThemeSurfaceCssVariables,
  buildSolidThemeSurfaceVariables,
  getThemeSurfaceVariables,
  getThemeTokens,
} from '@syrnike13/ui/tokens'

describe('theme surfaces', () => {
  it('maps Prism roles onto the desktop surface contract', () => {
    const settings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'monolit',
      colorMode: 'dark' as const,
    }
    const tokens = getThemeTokens(settings, true)
    const surfaces = getThemeSurfaceVariables(settings, true)

    expect(surfaces['theme-backdrop']).toBe(tokens.background)
    expect(surfaces['theme-surface-lowest']).toBe(tokens.background)
    expect(surfaces['theme-surface-app-frame']).toBe(tokens.background)
    expect(surfaces['theme-surface-navigation']).toBe(tokens.sidebar)
    expect(surfaces['theme-surface-content']).toBe(tokens.card)
    expect(surfaces['theme-surface-chrome']).toBe(tokens.card)
    expect(surfaces['theme-surface-raised']).toBe(tokens['surface-raised'])
    expect(surfaces['theme-surface-input']).toBe(tokens.input)
    expect(surfaces['theme-surface-highest']).toBe(tokens.secondary)
    expect(surfaces['theme-surface-floating']).toBe(tokens['surface-raised'])
    expect(surfaces['theme-surface-solid']).toBe(tokens.popover)
  })

  it('keeps the generated border roles in the surface tokens', () => {
    const settings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'glina',
      colorMode: 'light' as const,
    }
    const tokens = getThemeTokens(settings, false)
    const surfaces = buildSolidThemeSurfaceVariables(tokens)

    expect(tokens.border).toBe(tokens['input-border'])
    expect(tokens.border).toBe(tokens['sidebar-border'])
    expect(tokens.border).toBe(tokens.divider)
    expect(surfaces['theme-surface-content']).toBe(tokens.card)
  })

  it('exposes every surface variable as a CSS custom property', () => {
    const surfaces = buildSolidThemeSurfaceVariables(
      getThemeTokens(
        { ...DEFAULT_APPEARANCE_SETTINGS, themeId: 'monolit', colorMode: 'light' },
        false,
      ),
    )
    const variables = allThemeSurfaceCssVariables(surfaces)

    for (const key of THEME_SURFACE_VARIABLE_KEYS) {
      expect(variables[`--${key}`]).toBe(surfaces[key])
    }
  })
})
