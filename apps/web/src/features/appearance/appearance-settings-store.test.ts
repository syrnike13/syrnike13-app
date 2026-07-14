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
    appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
    localStorage.clear()
  })

  it('persists theme changes to localStorage on web', () => {
    appearanceSettingsStore.setThemeId('lug')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain('lug')
    expect(appearanceSettingsStore.getState().themeId).toBe('lug')
  })

  it('migrates legacy next-themes storage key', () => {
    localStorage.clear()
    localStorage.setItem('theme', 'light')
    expect(readStoredAppearanceSettings()).toEqual({
      themeId: 'syrnike',
      colorMode: 'light',
      gradient: null,
    })
    expect(localStorage.getItem('theme')).toBeNull()
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeTruthy()
  })

  it('returns a snapshot instead of the live store state', () => {
    const snapshot = appearanceSettingsStore.getState()
    snapshot.themeId = 'mutated'

    expect(appearanceSettingsStore.getState()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })

  it('does not expose the live gradient color array', () => {
    appearanceSettingsStore.setGradient({
      colors: ['#112233', '#AABBCC'],
      angle: 90,
      saturation: 80,
    })
    const snapshot = appearanceSettingsStore.getState()
    snapshot.gradient!.colors[0] = '#FFFFFF'

    expect(appearanceSettingsStore.getState().gradient?.colors[0]).toBe('#112233')
  })

  it('applies gradient changes from a complete settings update', () => {
    appearanceSettingsStore.setSettings({
      ...DEFAULT_APPEARANCE_SETTINGS,
      gradient: {
        colors: ['#112233', '#AABBCC'],
        angle: 45,
        saturation: 80,
      },
    })

    expect(appearanceSettingsStore.getState().gradient).toEqual({
      colors: ['#112233', '#AABBCC'],
      angle: 45,
      saturation: 80,
    })
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
