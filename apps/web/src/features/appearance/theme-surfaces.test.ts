import { describe, expect, it } from 'vitest'

import { getThemeById } from '#/features/appearance/theme-registry'
import {
  buildSolidThemeSurfaceVariables,
  buildThemeSurfaceVariables,
  themeGradientCss,
  tintThemeTokensForGradient,
} from '#/features/appearance/theme-surfaces'

const gradient = {
  colors: ['#5865F2', '#F4F4F5'],
  angle: 0,
  saturation: 74,
}

function surfaceOverlayAlpha(surface: string): number {
  const match = surface.match(/rgb\([^/]+\/ ([\d.]+)\)/)
  if (!match?.[1]) throw new Error(`Surface has no overlay alpha: ${surface}`)
  return Number(match[1])
}

describe('theme surfaces', () => {
  it('builds a viewport-aligned multi-color backdrop', () => {
    const variables = buildThemeSurfaceVariables(gradient, 'dark')

    expect(variables['theme-backdrop']).toBe(
      'linear-gradient(0deg, #5865F2, #F4F4F5)',
    )
    expect(variables['theme-surface-content']).toContain('fixed 0 0 / cover')
    expect(variables['theme-surface-content']).toContain(
      'linear-gradient(0deg, #5865F2, #F4F4F5)',
    )
    expect(variables['theme-surface-content']).not.toBe(
      variables['theme-surface-navigation'],
    )
    expect(variables['theme-surface-chrome']).toContain('fixed 0 0 / cover')
    expect(variables['theme-surface-chrome']).not.toBe(
      variables['theme-surface-navigation'],
    )
    expect(variables['theme-surface-floating']).toContain('fixed 0 0 / cover')
    expect(variables['theme-surface-floating']).not.toBe(
      variables['theme-surface-raised'],
    )
    expect(variables['theme-surface-solid']).not.toContain('linear-gradient')
    expect(variables['theme-surface-solid']).not.toContain('transparent')
    expect(variables['theme-surface-input']).toContain('fixed 0 0 / cover')
    expect(variables['theme-surface-input']).not.toBe(
      variables['theme-surface-floating'],
    )
  })

  it('keeps every generated surface opacity within CSS alpha bounds', () => {
    for (const variant of ['dark', 'light'] as const) {
      const surfaces = buildThemeSurfaceVariables(gradient, variant)

      for (const [key, surface] of Object.entries(surfaces)) {
        if (key === 'theme-backdrop' || key === 'theme-surface-solid') continue
        expect(surfaceOverlayAlpha(surface)).toBeGreaterThanOrEqual(0)
        expect(surfaceOverlayAlpha(surface)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('keeps the shell foundation independently configurable', () => {
    const dark = buildThemeSurfaceVariables(gradient, 'dark')
    const light = buildThemeSurfaceVariables(gradient, 'light')

    expect(dark['theme-surface-lowest']).not.toBe(
      dark['theme-surface-app-frame'],
    )
    expect(dark['theme-surface-lowest']).not.toBe(
      dark['theme-surface-content'],
    )
    expect(light['theme-surface-lowest']).not.toBe(
      light['theme-surface-app-frame'],
    )
    expect(light['theme-surface-lowest']).not.toBe(
      light['theme-surface-content'],
    )
  })

  it('keeps solid theme chrome on the existing card surface', () => {
    const base = getThemeById('syrnike').variants.dark!
    const surfaces = buildSolidThemeSurfaceVariables(base)

    expect(surfaces['theme-surface-content']).toBe(base.card)
    expect(surfaces['theme-surface-lowest']).toBe(base.background)
    expect(surfaces['theme-surface-navigation']).toBe(base.background)
    expect(surfaces['theme-surface-chrome']).toBe(base.card)
    expect(surfaces['theme-surface-input']).toBe(base.input)
    expect(surfaces['theme-surface-solid']).toBe(base.popover)
  })

  it('builds a solid surface from the equal-weight Oklab average', () => {
    const threeStops = {
      ...gradient,
      colors: ['#FF0000', '#00FF00', '#0000FF'],
    }
    const dark = buildThemeSurfaceVariables(threeStops, 'dark')
    const light = buildThemeSurfaceVariables(threeStops, 'light')

    expect(dark['theme-surface-solid']).toContain(
      'color-mix(in oklab, #FF0000 50%, #00FF00 50%) 66.6667%, #0000FF 33.3333%',
    )
    expect(dark['theme-surface-solid']).toContain('black')
    expect(light['theme-surface-solid']).toContain('white')
    expect(dark['theme-surface-solid']).not.toContain('linear-gradient')
    expect(light['theme-surface-solid']).not.toContain('transparent')
  })

  it('duplicates a single stop into a valid gradient', () => {
    expect(
      themeGradientCss({ ...gradient, colors: ['#112233'], angle: 90 }),
    ).toBe('linear-gradient(90deg, #112233, #112233)')
  })

  it('tints neutral surfaces without changing semantic brand colors', () => {
    const base = getThemeById('syrnike').variants.dark!
    const tinted = tintThemeTokensForGradient(base, gradient, 'dark')

    expect(tinted.background).toContain('color-mix(in oklab')
    expect(tinted.background).toContain('transparent')
    expect(tinted.card).toContain('transparent')
    expect(tinted.popover).toContain('transparent')
    expect(tinted.secondary).toContain('transparent')
    expect(tinted.muted).toContain('transparent')
    expect(tinted.accent).toContain('transparent')
    expect(tinted.input).toContain('transparent')
    expect(tinted.foreground).toContain('white')
    expect(tinted.border).toContain('color-mix(in oklab')
    expect(tinted.border).toContain('transparent')
    expect(tinted['sidebar-border']).toContain('transparent')
    expect(tinted['shell-divider']).toContain('transparent')
    expect(tinted.primary).toBe(base.primary)
    expect(tinted.destructive).toBe(base.destructive)
    expect(tinted.ring).toBe(base.ring)
  })

  it('keeps interaction surfaces lighter than structural surfaces', () => {
    const base = getThemeById('syrnike').variants.dark!
    const tinted = tintThemeTokensForGradient(base, gradient, 'dark')

    expect(tinted.card).toContain('68%')
    expect(tinted.secondary).toContain('50%')
    expect(tinted.muted).toContain('44%')
    expect(tinted.accent).toContain('38%')
    expect(tinted.input).toContain('46%')
  })
})
