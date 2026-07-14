import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_THEME_ID,
} from '@syrnike13/platform'

import {
  allThemeCssVariables,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
} from '#/features/appearance/theme-registry'
import { allThemeSurfaceCssVariables } from '#/features/appearance/theme-surfaces'

function cssVariablesBlock(
  selector: string,
  variables: Record<string, string>,
): string {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')

  return `${selector} {\n${declarations}\n}`
}

/** CSS fallback до applyThemeToDocument: цвета дефолтной темы из каталога. */
export function getDefaultThemeCss(): string {
  const theme = getThemeById(DEFAULT_THEME_ID)
  const lightSettings = {
    ...DEFAULT_APPEARANCE_SETTINGS,
    colorMode: 'light' as const,
  }
  const darkSettings = {
    ...DEFAULT_APPEARANCE_SETTINGS,
    colorMode: 'dark' as const,
  }
  const light = theme.variants.light
  const dark = theme.variants.dark

  if (!light || !dark) {
    return ''
  }

  return [
    cssVariablesBlock(':root', {
      ...allThemeCssVariables(getThemeTokens(lightSettings, false)),
      ...allThemeSurfaceCssVariables(
        getThemeSurfaceVariables(lightSettings, false),
      ),
    }),
    cssVariablesBlock('.dark', {
      ...allThemeCssVariables(getThemeTokens(darkSettings, true)),
      ...allThemeSurfaceCssVariables(
        getThemeSurfaceVariables(darkSettings, true),
      ),
    }),
  ].join('\n\n')
}
