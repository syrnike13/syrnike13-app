export type ThemeVariant = 'light' | 'dark'
export type AppearanceColorMode = 'light' | 'dark' | 'system'

export type ThemeGradientSettings = {
  colors: string[]
  angle: number
  saturation: number
}

/** Minimal theme settings contract shared by web and admin. */
export type ThemeSettings = {
  themeId: string
  colorMode: AppearanceColorMode
  gradient?: ThemeGradientSettings | null
}

export const DEFAULT_THEME_ID = 'syrnike'

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  themeId: DEFAULT_THEME_ID,
  colorMode: 'system',
}
