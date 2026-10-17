import {
  allThemeCssVariables,
  getThemeById,
  getThemeSurfaceVariables,
  getThemeTokens,
} from './registry'
import { allThemeSurfaceCssVariables } from './surfaces'
import { DEFAULT_THEME_ID, DEFAULT_THEME_SETTINGS } from './types'

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
    ...DEFAULT_THEME_SETTINGS,
    colorMode: 'light' as const,
  }
  const darkSettings = {
    ...DEFAULT_THEME_SETTINGS,
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
