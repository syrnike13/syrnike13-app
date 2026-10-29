// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemePickerGrid } from '#/components/appearance/theme-picker-grid'
import { usePrismWorkbench } from '#/features/dev-tools/use-prism-workbench'
import { appearanceSettingsStore } from '#/features/appearance/appearance-settings-store'
import { AppearanceProvider } from '#/features/appearance/appearance-context'

function renderGrid() {
  return render(
    <AppearanceProvider>
      <ThemePickerGrid />
    </AppearanceProvider>,
  )
}

beforeEach(() => {
  appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
})

afterEach(() => {
  cleanup()
  appearanceSettingsStore.setSettings(DEFAULT_APPEARANCE_SETTINGS)
})

/** Dev-панель в фоне не должна сбрасывать палитру на monolit. */
function WorkbenchHarness() {
  usePrismWorkbench(false)
  return <ThemePickerGrid />
}

describe('ThemePickerGrid', () => {
  it('keeps the selected palette while the dev workbench is idle', async () => {
    render(
      <AppearanceProvider>
        <WorkbenchHarness />
      </AppearanceProvider>,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Включить «Синтвейв» в тёмной теме' }),
    )

    // Даём отработать отложенным эффектам (rAF) дев-панели.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(
      document.documentElement.style.getPropertyValue('--primary').trim(),
    ).toBe('#ff3fd0')
  })

  it('applies a theme clicked in a card to the active slot', () => {
    renderGrid()

    fireEvent.click(screen.getByRole('button', { name: 'Тема «Глина»' }))

    expect(document.documentElement.dataset.theme).toBe('glina')
    expect(appearanceSettingsStore.getState().themeIds.dark).toBe('glina')
    expect(appearanceSettingsStore.getState().themeIds.light).toBe('monolit')
  })

  it('applies a theme to the light slot from the sun orb and shows it', () => {
    renderGrid()

    fireEvent.click(
      screen.getByRole('button', { name: 'Включить «Сакура» в светлой теме' }),
    )

    expect(appearanceSettingsStore.getState().themeIds.light).toBe('sakura')
    expect(appearanceSettingsStore.getState().colorMode).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('sakura')
  })

  it('switches the document when the active slot gets a new theme', () => {
    renderGrid()

    fireEvent.click(
      screen.getByRole('button', { name: 'Включить «Океан» в тёмной теме' }),
    )

    expect(document.documentElement.dataset.theme).toBe('ocean')
    expect(appearanceSettingsStore.getState().colorMode).toBe('dark')
  })

  it('selects gradient presets per mode and clears the gradient when returning to a solid preset', () => {
    renderGrid()

    fireEvent.click(
      screen.getByRole('button', { name: 'Тема «Северное сияние»' }),
    )
    expect(appearanceSettingsStore.getState().themeIds.dark).toBe(
      'gradient-aurora',
    )
    expect(document.documentElement.dataset.prismGradient).toBe('true')
    expect(
      document.documentElement.style.getPropertyValue('--app-gradient'),
    ).toContain('linear-gradient')

    fireEvent.click(
      screen.getByRole('button', { name: 'Включить «Закат» в светлой теме' }),
    )
    expect(appearanceSettingsStore.getState().themeIds).toEqual({
      light: 'gradient-sunset',
      dark: 'gradient-aurora',
    })
    expect(document.documentElement.dataset.themeResolved).toBe('light')
    expect(document.documentElement.dataset.themeGradient).toBe('prism')

    fireEvent.click(screen.getByRole('button', { name: 'Тема «Глина»' }))
    expect(document.documentElement.dataset.themeGradient).toBe('none')
    expect(document.documentElement.dataset.prismGradient).toBeUndefined()
    expect(
      document.documentElement.style.getPropertyValue('--app-gradient'),
    ).toBe('none')
    expect(appearanceSettingsStore.getState().themeIds.dark).toBe(
      'gradient-aurora',
    )
  })
})
