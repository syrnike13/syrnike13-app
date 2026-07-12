import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_ID } from '@syrnike13/platform'

import { getDefaultThemeCss } from '#/features/appearance/theme-default-css'
import {
  allThemeCssVariables,
  getThemeById,
} from '#/features/appearance/theme-registry'

describe('getDefaultThemeCss', () => {
  it('emits default theme variables for :root and .dark', () => {
    const theme = getThemeById(DEFAULT_THEME_ID)
    const css = getDefaultThemeCss()

    expect(css).toContain(':root {')
    expect(css).toContain('.dark {')
    expect(css).toContain(
      `--destructive: ${theme.variants.dark!.destructive};`,
    )
    expect(css).toContain(
      `--background: ${allThemeCssVariables(theme.variants.light!)['--background']};`,
    )
  })
})
