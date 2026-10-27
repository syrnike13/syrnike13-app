import { describe, expect, it } from 'vitest'

import {
  APPEARANCE_CUSTOM_THEME_LIMIT,
  DEFAULT_APPEARANCE_SETTINGS,
  cloneAppearanceCustomThemes,
  normalizeAppearanceCustomThemes,
  normalizeAppearanceSettings,
  normalizeAppearanceSettingsPatch,
  normalizeAppearanceThemeIds,
} from './appearance'

function anchors(accent: string) {
  return {
    accent,
    background: '#FFFFFF',
    foreground: '#111111',
    contrast: 50,
  }
}

describe('appearance theme selection', () => {
  it('migrates a single legacy theme id into both slots', () => {
    expect(
      normalizeAppearanceSettings({
        themeId: 'glina',
        colorMode: 'dark',
        scale: 100,
        gradient: null,
      }).themeIds,
    ).toEqual({ light: 'glina', dark: 'glina' })
  })

  it('keeps independent light and dark theme ids', () => {
    expect(
      normalizeAppearanceSettings({
        themeIds: { light: 'sakura', dark: 'ocean' },
        colorMode: 'system',
      }).themeIds,
    ).toEqual({ light: 'sakura', dark: 'ocean' })
  })

  it('fills missing slots from the legacy id and defaults', () => {
    expect(normalizeAppearanceThemeIds({ light: 'matrix' }, 'glina')).toEqual({
      light: 'matrix',
      dark: 'glina',
    })
    expect(normalizeAppearanceThemeIds({}, undefined)).toEqual(
      DEFAULT_APPEARANCE_SETTINGS.themeIds,
    )
  })

  it('turns a legacy patch into both slots', () => {
    expect(
      normalizeAppearanceSettingsPatch({ themeId: 'amber' })?.themeIds,
    ).toEqual({ light: 'amber', dark: 'amber' })
  })
})

describe('custom themes', () => {
  it('drops entries with a missing name or invalid anchors', () => {
    const themes = normalizeAppearanceCustomThemes([
      { id: 'custom-a', name: '  ', anchors: { light: anchors('#112233'), dark: anchors('#112233') } },
      { id: 'custom-b', name: 'Без якорей', anchors: { light: null, dark: null } },
      { id: 'custom-c', name: 'Плохой цвет', anchors: { light: { ...anchors('#zzzzzz') }, dark: anchors('#112233') } },
      { id: 'custom-d', name: '  Хорошая  ', anchors: { light: anchors('#112233'), dark: anchors('#445566') } },
    ])

    expect(themes).toHaveLength(1)
    expect(themes[0]).toMatchObject({ id: 'custom-d', name: 'Хорошая' })
  })

  it('normalizes anchor colors and clamps contrast', () => {
    const [theme] = normalizeAppearanceCustomThemes([
      {
        id: 'custom-a',
        name: 'Тема',
        anchors: {
          light: { ...anchors('#abcdef'), contrast: 500 },
          dark: { ...anchors('#123456'), contrast: -20 },
        },
      },
    ])

    expect(theme?.anchors.light).toEqual({
      accent: '#ABCDEF',
      background: '#FFFFFF',
      foreground: '#111111',
      contrast: 100,
    })
    expect(theme?.anchors.dark.contrast).toBe(0)
  })

  it('drops duplicates and stops at the limit', () => {
    const entries = Array.from(
      { length: APPEARANCE_CUSTOM_THEME_LIMIT + 5 },
      (_, index) => ({
        id: `custom-${index}`,
        name: `Тема ${index}`,
        anchors: { light: anchors('#112233'), dark: anchors('#112233') },
      }),
    )
    expect(normalizeAppearanceCustomThemes(entries)).toHaveLength(
      APPEARANCE_CUSTOM_THEME_LIMIT,
    )

    expect(
      normalizeAppearanceCustomThemes([entries[0], entries[0]]),
    ).toHaveLength(1)
  })

  it('clones custom themes without sharing anchor objects', () => {
    const [source] = normalizeAppearanceCustomThemes([
      {
        id: 'custom-a',
        name: 'Тема',
        anchors: { light: anchors('#112233'), dark: anchors('#445566') },
      },
    ])
    const [copy] = cloneAppearanceCustomThemes([source!])

    copy!.anchors.light.accent = '#000000'
    expect(source!.anchors.light.accent).toBe('#112233')
  })
})
