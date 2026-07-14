import { describe, expect, it } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  THEME_CATALOG,
  THEME_TOKEN_KEYS,
  applyBrandLockedThemeTokens,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
  resolveThemeVariant,
  themePreviewColors,
} from '#/features/appearance/theme-registry'

const OKLCH_PATTERN = /^(oklch\([^)]+\)|rgb\([^)]+\))$/

describe('theme registry', () => {
  it('contains the default syrnike theme', () => {
    expect(getThemeById('syrnike').id).toBe('syrnike')
    expect(getThemeById('missing')).toEqual(getThemeById('syrnike'))
  })

  it('defines complete token sets for every theme variant', () => {
    for (const theme of THEME_CATALOG) {
      for (const tokens of Object.values(theme.variants)) {
        expect(tokens).toBeDefined()
        for (const key of THEME_TOKEN_KEYS) {
          expect(tokens?.[key], `${theme.id} missing ${key}`).toBeTruthy()
        }
      }
    }
  })

  it('uses oklch or rgb color syntax for color tokens', () => {
    for (const theme of THEME_CATALOG) {
      for (const tokens of Object.values(theme.variants)) {
        if (!tokens) continue
        for (const key of THEME_TOKEN_KEYS) {
          if (key.startsWith('scrollbar')) {
            expect(tokens[key]).toMatch(/^rgb\(/)
            continue
          }
          expect(tokens[key], `${theme.id}.${key}`).toMatch(OKLCH_PATTERN)
        }
      }
    }
  })

  it('resolves system color mode from preference', () => {
    expect(
      resolveThemeVariant(
        { ...DEFAULT_APPEARANCE_SETTINGS, colorMode: 'system' },
        true,
      ),
    ).toBe('dark')
    expect(
      resolveThemeVariant(
        { ...DEFAULT_APPEARANCE_SETTINGS, colorMode: 'system' },
        false,
      ),
    ).toBe('light')
  })

  it('forces matrix to dark regardless of color mode', () => {
    expect(
      resolveThemeVariant(
        { ...DEFAULT_APPEARANCE_SETTINGS, themeId: 'matrix', colorMode: 'light' },
        false,
      ),
    ).toBe('dark')
  })

  it('keeps the existing solid palettes and exposes a separate gradient theme', () => {
    expect(THEME_CATALOG.map((theme) => theme.id)).toEqual([
      'syrnike',
      'lug',
      'iskra',
      'matrix',
      'monolit',
      'pergament',
      'grafit',
      'kontrast',
      'gradient-twilight',
      'gradient-aurora',
      'gradient-sunset',
      'gradient',
    ])
    expect(getThemeById('syrnike').name).toBe('Сырники')
    expect(getThemeById('syrnike').kind).toBe('solid')
    expect(getThemeById('gradient').kind).toBe('gradient')
    expect(getThemeById('gradient').customizable).toBe(true)
  })

  it('keeps brand-locked tokens from syrnike for every theme', () => {
    const syrnikeLight = getThemeById('syrnike').variants.light!
    const syrnikeDark = getThemeById('syrnike').variants.dark!

    for (const theme of THEME_CATALOG) {
      if (theme.variants.light) {
        const resolved = applyBrandLockedThemeTokens(theme.variants.light, 'light')
        for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
          expect(resolved[key], `${theme.id} light ${key}`).toBe(syrnikeLight[key])
        }
      }
      if (theme.variants.dark) {
        const resolved = applyBrandLockedThemeTokens(theme.variants.dark, 'dark')
        for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
          expect(resolved[key], `${theme.id} dark ${key}`).toBe(syrnikeDark[key])
        }
      }
    }
  })

  it('resolves lug theme with syrnike brand tokens via getThemeTokens', () => {
    const tokens = getThemeTokens(
      { ...DEFAULT_APPEARANCE_SETTINGS, themeId: 'lug', colorMode: 'light' },
      false,
    )
    const syrnikeLight = getThemeById('syrnike').variants.light!
    for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
      expect(tokens[key]).toBe(syrnikeLight[key])
    }
    expect(tokens.background).toBe(getThemeById('lug').variants.light!.background)
  })

  it('tints tokens and builds gradient surfaces only for gradient themes', () => {
    const gradientSettings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'gradient',
      colorMode: 'dark' as const,
    }
    const tokens = getThemeTokens(gradientSettings, true)
    const surfaces = getThemeSurfaceVariables(gradientSettings, true)

    expect(tokens.background).toContain('color-mix(in oklab')
    expect(surfaces['theme-backdrop']).toContain('linear-gradient')

    const solidSettings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'lug',
      colorMode: 'dark' as const,
    }
    const solidTokens = getThemeTokens(solidSettings, true)
    const solidSurfaces = getThemeSurfaceVariables(solidSettings, true)
    expect(solidSurfaces['theme-backdrop']).toBe(solidTokens.background)
    expect(solidSurfaces['theme-surface-content']).toBe(solidTokens.card)
  })

  it('keeps preset gradients independent from custom gradient settings', () => {
    const settings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'gradient-aurora',
      colorMode: 'dark' as const,
      gradient: {
        colors: ['#112233', '#AABBCC'],
        angle: 45,
        saturation: 80,
      },
    }

    expect(getThemeSurfaceVariables(settings, true)['theme-backdrop']).toBe(
      'linear-gradient(120deg, #163A72, #267F72, #59388E)',
    )
  })

  it('uses catalog palette colors in theme picker previews (not brand-locked)', () => {
    const lug = themePreviewColors(getThemeById('lug'), 'dark')
    const iskra = themePreviewColors(getThemeById('iskra'), 'dark')
    expect(lug.primary).toBe(getThemeById('lug').variants.dark!.primary)
    expect(iskra.primary).toBe(getThemeById('iskra').variants.dark!.primary)
    expect(lug.primary).not.toBe(iskra.primary)
  })
})
