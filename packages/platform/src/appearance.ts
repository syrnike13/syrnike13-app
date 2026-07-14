export type AppearanceColorMode = 'light' | 'dark' | 'system'

export const APPEARANCE_GRADIENT_MIN_COLORS = 1
export const APPEARANCE_GRADIENT_MAX_COLORS = 5

export type AppearanceGradientSettings = {
  colors: string[]
  angle: number
  saturation: number
}

export type AppearanceSettings = {
  themeId: string
  colorMode: AppearanceColorMode
  /** `null` использует градиент выбранной палитры. */
  gradient: AppearanceGradientSettings | null
}

export const DEFAULT_THEME_ID = 'syrnike'

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeId: DEFAULT_THEME_ID,
  colorMode: 'dark',
  gradient: null,
}

const COLOR_MODES = new Set<AppearanceColorMode>(['light', 'dark', 'system'])
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeGradientColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const color = value.trim()
  return HEX_COLOR_PATTERN.test(color) ? color.toUpperCase() : null
}

function cloneGradient(
  gradient: AppearanceGradientSettings | null,
): AppearanceGradientSettings | null {
  return gradient ? { ...gradient, colors: [...gradient.colors] } : null
}

export function normalizeAppearanceGradientSettings(
  value: unknown,
): AppearanceGradientSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const gradient = value as Record<string, unknown>
  if (!Array.isArray(gradient.colors)) return null
  const colors = gradient.colors
    .map(normalizeGradientColor)
    .filter((color): color is string => color !== null)
    .slice(0, APPEARANCE_GRADIENT_MAX_COLORS)
  if (colors.length < APPEARANCE_GRADIENT_MIN_COLORS) return null

  const angle = typeof gradient.angle === 'number' && Number.isFinite(gradient.angle)
    ? Math.round(clamp(gradient.angle, 0, 360))
    : 0
  const saturation =
    typeof gradient.saturation === 'number' && Number.isFinite(gradient.saturation)
      ? Math.round(clamp(gradient.saturation, 0, 100))
      : 74

  return { colors, angle, saturation }
}

export function normalizeAppearanceColorMode(
  value: unknown,
  fallback: AppearanceColorMode = DEFAULT_APPEARANCE_SETTINGS.colorMode,
): AppearanceColorMode {
  return typeof value === 'string' && COLOR_MODES.has(value as AppearanceColorMode)
    ? (value as AppearanceColorMode)
    : fallback
}

export function normalizeAppearanceSettings(
  value: unknown,
  defaults: AppearanceSettings = DEFAULT_APPEARANCE_SETTINGS,
): AppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...defaults, gradient: cloneGradient(defaults.gradient) }
  }
  const settings = value as Record<string, unknown>
  const themeId =
    typeof settings.themeId === 'string' && settings.themeId.trim().length > 0
      ? settings.themeId.trim()
      : defaults.themeId
  return {
    themeId,
    colorMode: normalizeAppearanceColorMode(settings.colorMode, defaults.colorMode),
    gradient:
      settings.gradient === null
        ? null
        : normalizeAppearanceGradientSettings(settings.gradient) ??
          cloneGradient(defaults.gradient),
  }
}

export type AppearanceSettingsPatch = Partial<AppearanceSettings>

export function normalizeAppearanceSettingsPatch(
  value: unknown,
): AppearanceSettingsPatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const patch = value as Record<string, unknown>
  const next: AppearanceSettingsPatch = {}
  if (
    'themeId' in patch &&
    typeof patch.themeId === 'string' &&
    patch.themeId.trim().length > 0
  ) {
    next.themeId = patch.themeId.trim()
  }
  if ('colorMode' in patch) {
    next.colorMode = normalizeAppearanceColorMode(patch.colorMode)
  }
  if ('gradient' in patch) {
    if (patch.gradient === null) {
      next.gradient = null
    } else {
      const gradient = normalizeAppearanceGradientSettings(patch.gradient)
      if (gradient) next.gradient = gradient
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}
