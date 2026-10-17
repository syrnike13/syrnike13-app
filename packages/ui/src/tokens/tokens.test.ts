import { expect, test } from 'vitest'

import {
  THEME_CATALOG,
  cssColorToHex,
  getThemeSurfaceVariables,
  getThemeTokens,
} from './index'
import { DEFAULT_THEME_ID, type ThemeVariant } from './types'

test('catalog keeps all 21 theme ids and their variants', () => {
  expect(THEME_CATALOG).toHaveLength(21)
  expect(new Set(THEME_CATALOG.map((theme) => theme.id)).size).toBe(21)

  for (const theme of THEME_CATALOG) {
    const variants = Object.keys(theme.variants)
    expect(variants.length).toBeGreaterThan(0)
    for (const variant of variants) {
      expect(['light', 'dark']).toContain(variant)
    }
  }
})

test('token and surface derivation is stable for every theme variant', () => {
  const snapshot: Record<string, unknown> = {}

  for (const theme of THEME_CATALOG) {
    for (const variant of Object.keys(theme.variants) as ThemeVariant[]) {
      const settings = { themeId: theme.id, colorMode: variant }
      const prefersDark = variant === 'dark'
      snapshot[`${theme.id}/${variant}`] = {
        tokens: getThemeTokens(settings, prefersDark),
        surfaces: getThemeSurfaceVariables(settings, prefersDark),
      }
    }
  }

  expect(snapshot).toMatchSnapshot()
})

test('default dark background converts deterministically', () => {
  const tokens = getThemeTokens(
    { themeId: DEFAULT_THEME_ID, colorMode: 'dark' },
    true,
  )

  // Electron uses a separate #3D3A48 shell backdrop; the CSS background is darker.
  expect(cssColorToHex(tokens.background)).toBe('#323339')
})

test('brand-locked tokens stay identical across themes', () => {
  for (const variant of ['light', 'dark'] as const) {
    const base = getThemeTokens(
      { themeId: DEFAULT_THEME_ID, colorMode: variant },
      variant === 'dark',
    )

    for (const theme of THEME_CATALOG) {
      if (!theme.variants[variant]) continue
      const tokens = getThemeTokens(
        { themeId: theme.id, colorMode: variant },
        variant === 'dark',
      )
      expect(tokens.primary).toBe(base.primary)
      expect(tokens.destructive).toBe(base.destructive)
      expect(tokens.ring).toBe(base.ring)
      expect(tokens['chart-1']).toBe(base['chart-1'])
    }
  }
})
