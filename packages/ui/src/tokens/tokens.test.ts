import { expect, test } from 'vitest'

import {
  THEME_CATALOG,
  cssColorToHex,
  getThemeSurfaceVariables,
  getThemeTokens,
} from './index'
import { DEFAULT_THEME_ID } from './types'

test('catalog contains the Prism anchor presets', () => {
  expect(THEME_CATALOG.map((theme) => theme.id)).toEqual([
    'monolit',
    'glina',
    'matrix',
    'amber',
    'synthwave',
    'ocean',
    'sakura',
    'gradient-aurora',
    'gradient-sunset',
    'gradient-lagoon',
    'gradient-twilight',
  ])

  for (const theme of THEME_CATALOG) {
    for (const variant of ['light', 'dark'] as const) {
      const anchors = theme.anchors[variant]
      expect(anchors.background).toMatch(/^#[0-9a-f]{6}$/)
      expect(anchors.foreground).toMatch(/^#[0-9a-f]{6}$/)
      expect(anchors.accent).toMatch(/^#[0-9a-f]{6}$/)
      expect(anchors.contrast).toBeGreaterThanOrEqual(0)
      expect(anchors.contrast).toBeLessThanOrEqual(100)
    }
  }
})

test('token and surface derivation is stable for every theme variant', () => {
  const snapshot: Record<string, unknown> = {}

  for (const theme of THEME_CATALOG) {
    for (const variant of ['light', 'dark'] as const) {
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

  // Electron uses a separate #3D3A48 shell backdrop; the Prism background is darker.
  expect(cssColorToHex(tokens.background)).toBe('#09090B')
})

test('structural borders share one Prism role', () => {
  for (const theme of THEME_CATALOG) {
    for (const variant of ['light', 'dark'] as const) {
      const tokens = getThemeTokens(
        { themeId: theme.id, colorMode: variant },
        variant === 'dark',
      )
      expect(tokens.border, `${theme.id}/${variant}`).toBe(
        tokens['input-border'],
      )
      expect(tokens['sidebar-border']).toBe(tokens.border)
      expect(tokens.divider).toBe(tokens.border)
      expect(tokens['shell-divider']).toBe(tokens.border)
    }
  }
})

test('keeps per-theme gradient tokens through the app adapter', () => {
  const original = THEME_CATALOG[0]!
  const theme = {
    ...original,
    anchors: {
      light: original.anchors.light,
      dark: {
        ...original.anchors.dark,
        gradient: { colors: ['#4c1d95', '#be185d'], angle: 45, mix: 60 },
      },
    },
  }
  const settings = { colorMode: 'dark' as const }
  const tokens = getThemeTokens(settings, true, theme)
  const surfaces = getThemeSurfaceVariables(settings, true, theme)
  expect(tokens['app-gradient']).toBe(
    'linear-gradient(45deg, #4c1d95, #be185d)',
  )
  expect(surfaces['theme-backdrop']).toBe(tokens['app-gradient'])
  expect(surfaces['theme-surface-navigation']).toBe(tokens['layer-sidebar'])
  expect(surfaces['theme-surface-content']).toBe(tokens['layer-panel'])
  expect(surfaces['theme-surface-floating']).toMatch(/^#[0-9a-f]{6}$/)
  expect(surfaces['theme-surface-solid']).toMatch(/^#[0-9a-f]{6}$/)
  const light = getThemeTokens({ colorMode: 'light' }, false, theme)
  expect(light['app-gradient']).toBe('none')
})
