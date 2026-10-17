export type ThemeVariant = 'light' | 'dark'
export type ThemeMode = ThemeVariant | 'system'

export type PrismAnchors = {
  accent: string
  background: string
  foreground: string
  /** Strength of surface separation, interactive states, and borders. */
  contrast: number
}

export type PrismVariants = Record<ThemeVariant, PrismAnchors>
export type PrismTheme = PrismVariants & { mode: ThemeMode }
export type PrismTokens = Record<`--${string}`, string>

export const MIN_CONTRAST = 0
export const MAX_CONTRAST = 100
export const DEFAULT_CONTRAST: Record<ThemeVariant, number> = {
  light: 45,
  dark: 60,
}
