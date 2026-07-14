// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  applyThemeToDocument,
  readSystemPrefersDark,
} from '#/features/appearance/apply-theme'
import { THEME_TOKEN_KEYS } from '#/features/appearance/theme-tokens'
import { THEME_SURFACE_VARIABLE_KEYS } from '#/features/appearance/theme-surfaces'

describe('applyThemeToDocument', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-theme-gradient')
    for (const key of THEME_TOKEN_KEYS) {
      document.documentElement.style.removeProperty(`--${key}`)
    }
    for (const key of THEME_SURFACE_VARIABLE_KEYS) {
      document.documentElement.style.removeProperty(`--${key}`)
    }
  })

  it('applies dark class and theme dataset', () => {
    const variant = applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      colorMode: 'dark',
    })
    expect(variant).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('syrnike')
    expect(document.documentElement.dataset.themeGradient).toBe('none')
  })

  it('uses the resolved theme id for the theme dataset', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'unknown-theme',
    })

    expect(document.documentElement.dataset.theme).toBe('syrnike')
  })

  it('writes css variables for active tokens', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      colorMode: 'dark',
    })
    const primary = document.documentElement.style.getPropertyValue('--primary')
    expect(primary).toContain('oklch')
    expect(
      document.documentElement.style.getPropertyValue('--theme-surface-content'),
    ).toBe(document.documentElement.style.getPropertyValue('--card'))
  })

  it('applies custom gradient colors and marks their source', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'gradient',
      gradient: {
        colors: ['#112233', '#AABBCC'],
        angle: 45,
        saturation: 80,
      },
    })

    expect(document.documentElement.dataset.themeGradient).toBe('custom')
    expect(
      document.documentElement.style.getPropertyValue('--theme-backdrop'),
    ).toBe('linear-gradient(45deg, #112233, #AABBCC)')
  })

  it('ignores a stored gradient while a solid theme is active', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'lug',
      gradient: {
        colors: ['#112233', '#AABBCC'],
        angle: 45,
        saturation: 80,
      },
    })

    expect(document.documentElement.dataset.themeGradient).toBe('none')
    expect(
      document.documentElement.style.getPropertyValue('--theme-backdrop'),
    ).toBe(document.documentElement.style.getPropertyValue('--background'))
  })

  it('uses syrnike brand tokens when another theme is selected', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'lug',
      colorMode: 'light',
    })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--primary').trim()).toBe('oklch(0.5774 0.2091 273.8504)')
    expect(style.getPropertyValue('--ring').trim()).toBe('oklch(0.5774 0.2091 273.8504)')
    expect(style.getPropertyValue('--destructive').trim()).toBe(
      'oklch(0.7040 0.1910 22.2160)',
    )
    expect(style.getPropertyValue('--destructive-contrast').trim()).toBe(
      'oklch(0.5156 0.1810 22.5393)',
    )
  })

  it('reads system preference helper without throwing', () => {
    expect(typeof readSystemPrefersDark()).toBe('boolean')
  })
})
