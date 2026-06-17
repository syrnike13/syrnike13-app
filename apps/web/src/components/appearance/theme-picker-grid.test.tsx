// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemePickerGrid } from '#/components/appearance/theme-picker-grid'
import { AppearanceProvider } from '#/features/appearance/appearance-context'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import { getThemeById } from '#/features/appearance/theme-registry'
import { easterModeStore } from '#/features/easter/easter-mode-store'
import {
  EASTER_NOTE_SOURCES,
  EASTER_PALETTE_HINT,
} from '#/features/easter/easter-palette-melody'
import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

const MELODY_THEME_SEQUENCE = [
  'syrnike',
  'syrnike',
  'lug',
  'iskra',
  'matrix',
  'monolit',
  'pergament',
  'syrnike',
  'pergament',
  'matrix',
  'grafit',
  'grafit',
  'lug',
  'iskra',
  'matrix',
  'monolit',
  'pergament',
  'syrnike',
  'pergament',
  'matrix',
]

function renderThemePickerGrid() {
  return render(
    <AppearanceProvider>
      <ThemePickerGrid />
    </AppearanceProvider>,
  )
}

describe('ThemePickerGrid easter mode', () => {
  const audioSources: string[] = []
  const play = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    localStorage.clear()
    audioSources.length = 0
    play.mockClear()
    easterModeStore.setEnabled(false)
    appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal(
      'Audio',
      class {
        volume = 0
        preload = ''

        constructor(src: string) {
          audioSources.push(src)
        }

        play = play
      },
    )
  })

  afterEach(() => {
    cleanup()
    appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
    easterModeStore.setEnabled(false)
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('shows the bone palette hint while the mode is locked', () => {
    renderThemePickerGrid()

    expect(screen.getByText(EASTER_PALETTE_HINT)).toBeTruthy()
    expect(
      screen.queryByRole('switch', { name: 'Пасхальный режим' }),
    ).toBeNull()
  })

  it('shows the easter mode toggle only while easter mode is enabled', async () => {
    easterModeStore.setEnabled(true)
    renderThemePickerGrid()

    const toggle = screen.getByRole('switch', { name: 'Пасхальный режим' })

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(
        screen.queryByRole('switch', { name: 'Пасхальный режим' }),
      ).toBeNull()
    })
    expect(easterModeStore.getState()).toBe(false)
  })

  it('selects the theme without playing the palette note', () => {
    renderThemePickerGrid()

    fireEvent.click(screen.getByText(getThemeById('lug').name))

    expect(appearanceSettingsStore.getState().themeId).toBe('lug')
    expect(audioSources).toEqual([])
    expect(play).not.toHaveBeenCalled()
  })

  it('plays the palette note without selecting the theme', () => {
    renderThemePickerGrid()

    fireEvent.click(
      screen.getByRole('button', {
        name: `Сыграть ноту палитры ${getThemeById('lug').name}`,
      }),
    )

    expect(appearanceSettingsStore.getState().themeId).toBe('syrnike')
    expect(audioSources).toContain(EASTER_NOTE_SOURCES.d7)
    expect(play).toHaveBeenCalled()
  })

  it('activates easter mode after playing the full melody through swatches', () => {
    renderThemePickerGrid()

    for (const themeId of MELODY_THEME_SEQUENCE) {
      fireEvent.click(
        screen.getByRole('button', {
          name: `Сыграть ноту палитры ${getThemeById(themeId).name}`,
        }),
      )
    }

    expect(easterModeStore.getState()).toBe(true)
  })
})
