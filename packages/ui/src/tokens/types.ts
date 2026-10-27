export type ThemeVariant = 'light' | 'dark'
export type AppearanceColorMode = 'light' | 'dark' | 'system'

/** Minimal theme settings contract shared by web and admin. */
export type ThemeSettings = {
  /** Тема-фолбэк; web выбирает тему под вариант отдельно. */
  themeId?: string
  colorMode: AppearanceColorMode
}

export const DEFAULT_THEME_ID = 'monolit'

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  themeId: DEFAULT_THEME_ID,
  colorMode: 'system',
}
