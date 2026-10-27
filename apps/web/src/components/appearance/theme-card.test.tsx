// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getThemeById } from '@syrnike13/ui/tokens'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeCard } from '#/components/appearance/theme-card'

afterEach(cleanup)

describe('ThemeCard', () => {
  it('applies the theme to the active variant on a card click', () => {
    const onSelectActive = vi.fn()

    render(
      <ThemeCard
        theme={getThemeById('glina')}
        name="Глина"
        selected={{ light: false, dark: false }}
        onSelectActive={onSelectActive}
        onSelectVariant={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Тема «Глина»' }))
    expect(onSelectActive).toHaveBeenCalledOnce()
  })

  it('selects the light and dark slots separately', () => {
    const onSelectVariant = vi.fn()

    render(
      <ThemeCard
        theme={getThemeById('glina')}
        name="Глина"
        selected={{ light: false, dark: true }}
        onSelectActive={vi.fn()}
        onSelectVariant={onSelectVariant}
      />,
    )

    const light = screen.getByRole('button', {
      name: 'Включить «Глина» в светлой теме',
    })
    const dark = screen.getByRole('button', {
      name: 'Включить «Глина» в тёмной теме',
    })

    expect(light.getAttribute('aria-pressed')).toBe('false')
    expect(dark.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(light)
    expect(onSelectVariant).toHaveBeenCalledWith('light')

    fireEvent.click(dark)
    expect(onSelectVariant).toHaveBeenCalledWith('dark')
  })

  it('shows edit, duplicate and delete actions only for custom themes', () => {
    const { rerender } = render(
      <ThemeCard
        theme={getThemeById('glina')}
        name="Глина"
        selected={{ light: true, dark: false }}
        onSelectActive={vi.fn()}
        onSelectVariant={vi.fn()}
      />,
    )

    expect(
      screen.queryByRole('button', { name: 'Изменить тему «Глина»' }),
    ).toBeNull()

    rerender(
      <ThemeCard
        theme={getThemeById('glina')}
        name="Глина"
        selected={{ light: true, dark: false }}
        onSelectActive={vi.fn()}
        onSelectVariant={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Изменить тему «Глина»' }),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Дублировать тему «Глина»' }),
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'Удалить тему «Глина»' }),
    ).not.toBeNull()
  })

  it('hides the variant badge for unselected slots', () => {
    render(
      <ThemeCard
        theme={getThemeById('glina')}
        name="Глина"
        selected={{ light: true, dark: false }}
        onSelectActive={vi.fn()}
        onSelectVariant={vi.fn()}
      />,
    )

    const light = screen.getByRole('button', {
      name: 'Включить «Глина» в светлой теме',
    })
    const dark = screen.getByRole('button', {
      name: 'Включить «Глина» в тёмной теме',
    })

    expect(light.querySelector('[data-slot="theme-variant-badge"]')).not.toBeNull()
    expect(dark.querySelector('[data-slot="theme-variant-badge"]')).toBeNull()
  })
})
