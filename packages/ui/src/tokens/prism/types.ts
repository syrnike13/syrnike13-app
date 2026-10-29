export type ThemeVariant = 'light' | 'dark'
export type ThemeMode = ThemeVariant | 'system'

/**
 * A window-wide gradient under translucent layers. `colors` are 2–5 stops, `angle` follows CSS
 * `linear-gradient` degrees, and `mix` (0–100) is how strongly the base surfaces cover it.
 */
export type PrismGradient = {
  colors: string[]
  angle: number
  mix: number
}

export type PrismAnchors = {
  accent: string
  background: string
  foreground: string
  /** Strength of surface separation, interactive states, and borders. */
  contrast: number
  gradient?: PrismGradient
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

export const MIN_GRADIENT_COLORS = 2
export const MAX_GRADIENT_COLORS = 5
export const MIN_GRADIENT_MIX = 0
export const MAX_GRADIENT_MIX = 100
