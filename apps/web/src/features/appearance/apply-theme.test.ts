// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  applyThemeToDocument,
  readSystemPrefersDark,
} from '#/features/appearance/apply-theme'
import { THEME_TOKEN_KEYS } from '#/features/appearance/theme-tokens'

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
    for (const key of THEME_TOKEN_KEYS) {
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
  })

  it('writes css variables for active tokens', () => {
    applyThemeToDocument({
      ...DEFAULT_APPEARANCE_SETTINGS,
      colorMode: 'dark',
    })
    const primary = document.documentElement.style.getPropertyValue('--primary')
    expect(primary).toContain('oklch')
  })

  it('reads system preference helper without throwing', () => {
    expect(typeof readSystemPrefersDark()).toBe('boolean')
  })
})
