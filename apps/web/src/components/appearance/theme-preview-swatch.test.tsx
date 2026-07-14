// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemePreviewSwatch } from '#/components/appearance/theme-preview-swatch'
import { TooltipProvider } from '#/components/ui/tooltip'
import { getThemeById } from '#/features/appearance/theme-registry'

afterEach(cleanup)

describe('ThemePreviewSwatch', () => {
  it('exposes and changes the selected theme', () => {
    const onSelect = vi.fn()

    render(
      <TooltipProvider>
        <ThemePreviewSwatch
          theme={getThemeById('syrnike')}
          active
          settings={DEFAULT_APPEARANCE_SETTINGS}
          prefersDark
          onSelect={onSelect}
        />
      </TooltipProvider>,
    )

    const swatch = screen.getByRole('button', { name: 'Тема «Сырники»' })
    expect(swatch.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(swatch)
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('renders a configured gradient inside a compact swatch', () => {
    render(
      <TooltipProvider>
        <ThemePreviewSwatch
          theme={getThemeById('gradient-twilight')}
          active={false}
          settings={DEFAULT_APPEARANCE_SETTINGS}
          prefersDark
          onSelect={vi.fn()}
        />
      </TooltipProvider>,
    )

    const swatch = screen.getByRole('button', { name: 'Тема «Сумерки»' })
    const preview = swatch.firstElementChild as HTMLElement

    expect(swatch.getAttribute('aria-pressed')).toBe('false')
    expect(preview.style.backgroundImage).toContain('linear-gradient')
  })
})
