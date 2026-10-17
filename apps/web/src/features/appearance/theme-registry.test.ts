import { describe, expect, it } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  BRAND_LOCKED_THEME_TOKEN_KEYS,
  BRAND_THEME_TOKENS,
  THEME_CATALOG,
  THEME_TOKEN_KEYS,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
  previewVariantForTheme,
  resolveThemeVariant,
  themePreviewColors,
} from '@syrnike13/ui/tokens'

describe('theme registry', () => {
  it('contains the default monolit theme', () => {
    expect(getThemeById('monolit').id).toBe('monolit')
    expect(getThemeById('missing')).toEqual(getThemeById('monolit'))
  })

  it('defines Prism anchors for both modes in every theme', () => {
    expect(THEME_CATALOG.map((theme) => theme.id)).toEqual(['monolit', 'glina'])
    expect(THEME_CATALOG.some((theme) => theme.id.startsWith('gradient'))).toBe(
      false,
    )

    for (const theme of THEME_CATALOG) {
      for (const variant of ['light', 'dark'] as const) {
        const anchors = theme.anchors[variant]
        expect(anchors.background, `${theme.id}/${variant}`).toMatch(
          /^#[0-9a-f]{6}$/,
        )
        expect(anchors.foreground).toMatch(/^#[0-9a-f]{6}$/)
        expect(anchors.accent).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('generates every semantic token for every theme variant', () => {
    for (const theme of THEME_CATALOG) {
      for (const variant of ['light', 'dark'] as const) {
        const tokens = getThemeTokens(
          { ...DEFAULT_APPEARANCE_SETTINGS, themeId: theme.id, colorMode: variant },
          variant === 'dark',
        )
        for (const key of THEME_TOKEN_KEYS) {
          expect(tokens[key], `${theme.id}/${variant}/${key}`).toBeTruthy()
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

  it('keeps brand-locked tokens fixed for every theme', () => {
    for (const theme of THEME_CATALOG) {
      for (const variant of ['light', 'dark'] as const) {
        const tokens = getThemeTokens(
          { ...DEFAULT_APPEARANCE_SETTINGS, themeId: theme.id, colorMode: variant },
          variant === 'dark',
        )
        for (const key of BRAND_LOCKED_THEME_TOKEN_KEYS) {
          expect(tokens[key], `${theme.id}/${variant}/${key}`).toBe(
            BRAND_THEME_TOKENS[variant][key],
          )
        }
      }
    }
  })

  it('derives surfaces from Prism roles', () => {
    const settings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'glina',
      colorMode: 'dark' as const,
    }
    const tokens = getThemeTokens(settings, true)
    const surfaces = getThemeSurfaceVariables(settings, true)

    expect(surfaces['theme-backdrop']).toBe(tokens.background)
    expect(surfaces['theme-surface-content']).toBe(tokens.card)
    expect(surfaces['theme-surface-raised']).toBe(tokens['surface-raised'])
    expect(surfaces['theme-surface-input']).toBe(tokens.input)
    expect(surfaces['theme-surface-solid']).toBe(tokens.popover)
  })

  it('keeps picker previews on the generated accent before brand lock', () => {
    const monolit = themePreviewColors(getThemeById('monolit'), 'dark')
    const glina = themePreviewColors(getThemeById('glina'), 'dark')

    expect(monolit.primary).not.toBe(glina.primary)
    expect(glina.primary).not.toBe(BRAND_THEME_TOKENS.dark.primary)
  })

  it('previews inactive themes in the preferred mode', () => {
    expect(
      previewVariantForTheme(
        getThemeById('glina'),
        { ...DEFAULT_APPEARANCE_SETTINGS, themeId: 'monolit' },
        true,
      ),
    ).toBe('dark')
  })
})
