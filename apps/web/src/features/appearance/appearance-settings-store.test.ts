// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import {
  APPEARANCE_STORAGE_KEY,
  appearanceSettingsStore,
  readStoredAppearanceSettings,
} from '#/features/appearance/appearance-settings-store'

describe('appearance settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  afterEach(() => {
    localStorage.clear()
    appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
  })

  it('persists theme changes to localStorage on web', () => {
    appearanceSettingsStore.setThemeId('lug')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain('lug')
    expect(appearanceSettingsStore.getState().themeId).toBe('lug')
  })

  it('migrates legacy next-themes storage key', async () => {
    localStorage.clear()
    localStorage.setItem('theme', 'light')
    const { readStoredAppearanceSettings: readSettings } = await import(
      '#/features/appearance/appearance-settings-store'
    )
    expect(readSettings()).toEqual({
      themeId: 'syrnike',
      colorMode: 'light',
    })
    expect(localStorage.getItem('theme')).toBeNull()
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeTruthy()
  })

  it('defaults to syrnike dark when storage is empty', () => {
    expect(readStoredAppearanceSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })

  it('notifies subscribers on change', () => {
    const listener = vi.fn()
    const unsubscribe = appearanceSettingsStore.subscribe(listener)
    appearanceSettingsStore.setColorMode('light')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})
