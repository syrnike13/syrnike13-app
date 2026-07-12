import { DEFAULT_THEME_ID } from '@syrnike13/platform'

import {
  allThemeCssVariables,
  getThemeById,
} from '#/features/appearance/theme-registry'

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
  const light = theme.variants.light
  const dark = theme.variants.dark

  if (!light || !dark) {
    return ''
  }

  return [
    cssVariablesBlock(':root', allThemeCssVariables(light)),
    cssVariablesBlock('.dark', allThemeCssVariables(dark)),
  ].join('\n\n')
}
