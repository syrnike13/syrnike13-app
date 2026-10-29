// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  applyThemeToDocument,
  readSystemPrefersDark,
} from '@syrnike13/ui/tokens'
import { THEME_TOKEN_KEYS } from '@syrnike13/ui/tokens'
import { THEME_SURFACE_VARIABLE_KEYS } from '@syrnike13/ui/tokens'

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
    expect(document.documentElement.dataset.theme).toBe('monolit')
    expect(document.documentElement.dataset.themeGradient).toBe('none')
  })

  it('uses the resolved theme id for the theme dataset', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'unknown-theme',
    })

    expect(document.documentElement.dataset.theme).toBe('monolit')
  })

  it('writes css variables for active tokens', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      colorMode: 'dark',
    })
    const primary = document.documentElement.style.getPropertyValue('--primary')
    expect(primary.trim()).toBe('#fafafa')
    expect(
      document.documentElement.style.getPropertyValue(
        '--theme-surface-content',
      ),
    ).toBe(document.documentElement.style.getPropertyValue('--card'))
  })

  it('derives primary and ring from the selected theme accent', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: 'glina',
      colorMode: 'light',
    })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--primary').trim()).toBe('#a85b3b')
    expect(style.getPropertyValue('--ring').trim()).toBe('#a85b3b')
    // Status/chart roles are now supplied by Prism's semantic.css, not inline JS.
    expect(style.getPropertyValue('--destructive')).toBe('')
  })

  it('reads system preference helper without throwing', () => {
    expect(typeof readSystemPrefersDark()).toBe('boolean')
  })

  it('clears window gradients and alpha layers when switching back to a solid theme', () => {
    const settings = {
      colorMode: 'dark' as const,
      gradient: { colors: ['#4c1d95', '#be185d'], angle: 45, mix: 60 },
    }
    applyThemeToDocument(settings)
    const root = document.documentElement
    expect(root.dataset.prismGradient).toBe('true')
    expect(root.dataset.themeGradient).toBe('prism')
    expect(root.style.getPropertyValue('--theme-backdrop')).toContain(
      'linear-gradient',
    )
    expect(root.style.getPropertyValue('--theme-surface-solid')).toMatch(
      /^#[0-9a-f]{6}$/,
    )
    applyThemeToDocument({ colorMode: 'light' })
    expect(root.dataset.prismGradient).toBeUndefined()
    expect(root.dataset.themeGradient).toBe('none')
    expect(root.style.getPropertyValue('--app-gradient')).toBe('none')
    expect(root.style.getPropertyValue('--layer-frame')).toBe(
      root.style.getPropertyValue('--background'),
    )
  })
})
