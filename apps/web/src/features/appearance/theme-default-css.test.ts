import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE_SETTINGS } from '@syrnike13/platform'

import { getDefaultThemeCss } from '@syrnike13/ui/tokens'
import { allThemeCssVariables, getThemeTokens } from '@syrnike13/ui/tokens'

describe('getDefaultThemeCss', () => {
  it('emits default theme variables for :root and .dark', () => {
    const lightTokens = getThemeTokens(
      { ...DEFAULT_APPEARANCE_SETTINGS, colorMode: 'light' },
      false,
    )
    const darkTokens = getThemeTokens(
      { ...DEFAULT_APPEARANCE_SETTINGS, colorMode: 'dark' },
      true,
    )
    const css = getDefaultThemeCss()

    expect(css).toContain(':root {')
    expect(css).toContain('.dark {')
    expect(css).toContain(`--background: ${darkTokens.background};`)
    expect(css).toContain(
      `--background: ${
        allThemeCssVariables(
          getThemeTokens(
            { ...DEFAULT_APPEARANCE_SETTINGS, colorMode: 'light' },
            false,
          ),
        )['--background']
      };`,
    )
    expect(css).toContain(`--theme-surface-content: ${lightTokens.card};`)
  })
})
