import { expect, test } from 'vitest'

import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  BRAND_THEME_TOKENS,
  THEME_CATALOG,
  cssColorToHex,
  getThemeSurfaceVariables,
  getThemeTokens,
} from './index'
import { DEFAULT_THEME_ID, type ThemeVariant } from './types'

test('catalog contains the Prism anchor presets', () => {
  expect(THEME_CATALOG.map((theme) => theme.id)).toEqual([
    'monolit',
    'glina',
    'matrix',
    'amber',
    'synthwave',
    'ocean',
    'sakura',
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
      expect(tokens.border, `${theme.id}/${variant}`).toBe(tokens['input-border'])
      expect(tokens['sidebar-border']).toBe(tokens.border)
      expect(tokens.divider).toBe(tokens.border)
      expect(tokens['shell-divider']).toBe(tokens.border)
    }
  }
})

test('brand-locked tokens stay identical across themes', () => {
  for (const variant of ['light', 'dark'] as const) {
    for (const theme of THEME_CATALOG) {
      const tokens = getThemeTokens(
        { themeId: theme.id, colorMode: variant },
        variant === 'dark',
      )
      for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
        expect(tokens[key], `${theme.id}/${variant}/${key}`).toBe(
          BRAND_THEME_TOKENS[variant as ThemeVariant][key],
        )
      }
    }
  }
})

test('tuning changes generated surfaces', () => {
  const settings = { themeId: 'glina', colorMode: 'dark' as const }
  const base = getThemeTokens(settings, true)
  const tuned = getThemeTokens(settings, true, {
    surfaceMix: { muted: 30, border: 30 },
  })

  expect(tuned.muted).not.toBe(base.muted)
  expect(tuned.border).not.toBe(base.border)
})

test('anchor overrides replace catalog colors', () => {
  const settings = { themeId: 'glina', colorMode: 'dark' as const }
  const base = getThemeTokens(settings, true)
  const overridden = getThemeTokens(settings, true, undefined, {
    dark: { background: '#112233', accent: '#ff8800' },
  })

  expect(overridden.background).toBe('#112233')
  expect(overridden.background).not.toBe(base.background)
  // `primary` stays brand-locked; the anchor reaches Prism-derived roles.
  expect(overridden['sidebar-primary']).toBe('#ff8800')
})

test('the sidebar mix drives the shell navigation layer', () => {
  const settings = { themeId: 'glina', colorMode: 'dark' as const }
  const base = getThemeTokens(settings, true)
  const tuned = getThemeTokens(settings, true, {
    surfaceMix: { sidebar: 30 },
  })
  const surfaces = getThemeSurfaceVariables(settings, true, {
    surfaceMix: { sidebar: 30 },
  })

  expect(tuned.sidebar).not.toBe(base.sidebar)
  expect(surfaces['theme-surface-navigation']).toBe(tuned.sidebar)
  expect(surfaces['theme-surface-lowest']).toBe(tuned.background)
  expect(surfaces['theme-surface-app-frame']).toBe(tuned.background)
})
