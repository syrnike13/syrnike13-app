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
    appearanceSettingsStore.setThemeId('glina')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain('glina')
    expect(appearanceSettingsStore.getState().themeIds).toEqual({
      light: 'glina',
      dark: 'glina',
    })
  })

  it('falls back to monolit for a removed theme id', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ themeId: 'lug', colorMode: 'dark', gradient: null }),
    )

    expect(readStoredAppearanceSettings().themeIds).toEqual({
      light: 'monolit',
      dark: 'monolit',
    })
  })

  it('migrates legacy next-themes storage key', () => {
    localStorage.clear()
    localStorage.setItem('theme', 'light')
    expect(readStoredAppearanceSettings()).toEqual({
      themeIds: { light: 'monolit', dark: 'monolit' },
      colorMode: 'light',
      scale: 100,
      gradient: null,
      customThemes: [],
    })
    expect(localStorage.getItem('theme')).toBeNull()
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeTruthy()
  })

  it('returns a snapshot instead of the live store state', () => {
    const snapshot = appearanceSettingsStore.getState()
    snapshot.themeIds.light = 'mutated'

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

  it('defaults to monolit dark when storage is empty', () => {
    expect(readStoredAppearanceSettings()).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })

  it('persists the interface scale and applies it to the root font size', () => {
    appearanceSettingsStore.setScale(125)

    expect(appearanceSettingsStore.getState().scale).toBe(125)
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain(
      '"scale":125',
    )
    expect(document.documentElement.style.fontSize).toBe('125%')
  })

  it('clamps the interface scale to the supported range', () => {
    appearanceSettingsStore.setScale(500)
    expect(appearanceSettingsStore.getState().scale).toBe(150)

    appearanceSettingsStore.setScale(10)
    expect(appearanceSettingsStore.getState().scale).toBe(80)
  })

  it('notifies subscribers on change', () => {
    const listener = vi.fn()
    const unsubscribe = appearanceSettingsStore.subscribe(listener)
    appearanceSettingsStore.setColorMode('light')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps light and dark themes independent', () => {
    appearanceSettingsStore.setThemeId('glina', 'light')
    expect(appearanceSettingsStore.getState().themeIds).toEqual({
      light: 'glina',
      dark: 'monolit',
    })

    appearanceSettingsStore.setThemeId('ocean', 'dark')
    expect(appearanceSettingsStore.getState().themeIds).toEqual({
      light: 'glina',
      dark: 'ocean',
    })
  })

  it('migrates a single legacy theme id into both slots', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ themeId: 'glina', colorMode: 'dark', gradient: null }),
    )

    expect(readStoredAppearanceSettings().themeIds).toEqual({
      light: 'glina',
      dark: 'glina',
    })
  })

  it('adds, updates, duplicates and removes a custom theme', () => {
    const theme = {
      id: 'custom-one',
      name: 'Моя тема',
      anchors: {
        light: {
          accent: '#112233',
          background: '#FFFFFF',
          foreground: '#000000',
          contrast: 45,
        },
        dark: {
          accent: '#AABBCC',
          background: '#000000',
          foreground: '#FFFFFF',
          contrast: 60,
        },
      },
    }

    appearanceSettingsStore.addCustomTheme(theme)
    expect(appearanceSettingsStore.getState().customThemes).toHaveLength(1)

    appearanceSettingsStore.updateCustomTheme('custom-one', (current) => ({
      ...current,
      name: 'Новая',
    }))
    expect(appearanceSettingsStore.getState().customThemes[0]?.name).toBe(
      'Новая',
    )

    appearanceSettingsStore.setThemeId('custom-one', 'dark')
    appearanceSettingsStore.removeCustomTheme('custom-one')
    expect(appearanceSettingsStore.getState().customThemes).toHaveLength(0)
    expect(appearanceSettingsStore.getState().themeIds.dark).toBe('monolit')
  })
})
