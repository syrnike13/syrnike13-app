import { describe, expect, it } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  THEME_CATALOG,
  THEME_TOKEN_KEYS,
  applyBrandLockedThemeTokens,
  getThemeById,
  getThemeTokens,
  resolveThemeVariant,
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
        { themeId: 'matrix', colorMode: 'light' },
        false,
      ),
    ).toBe('dark')
  })

  it('exposes eight palettes including syrnike base', () => {
    expect(THEME_CATALOG.map((theme) => theme.id)).toEqual([
      'syrnike',
      'lug',
      'iskra',
      'matrix',
      'monolit',
      'pergament',
      'grafit',
      'kontrast',
    ])
    expect(getThemeById('syrnike').name).toBe('Сырники')
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
      { themeId: 'lug', colorMode: 'light' },
      false,
    )
    const syrnikeLight = getThemeById('syrnike').variants.light!
    for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
      expect(tokens[key]).toBe(syrnikeLight[key])
    }
    expect(tokens.background).toBe(getThemeById('lug').variants.light!.background)
  })
})
