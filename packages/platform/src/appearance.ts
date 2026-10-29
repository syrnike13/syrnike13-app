import { Option, Schema } from 'effect'

export const AppearanceColorModeSchema = Schema.Literals([
  'light',
  'dark',
  'system',
])

export type AppearanceColorMode = typeof AppearanceColorModeSchema.Type

export const APPEARANCE_GRADIENT_MIN_COLORS = 2
export const APPEARANCE_GRADIENT_MAX_COLORS = 5

/** Масштаб интерфейса в процентах; меняет rem-размеры через font-size корня. */
export const APPEARANCE_SCALE_MIN = 80
export const APPEARANCE_SCALE_MAX = 150
export const APPEARANCE_SCALE_STEP = 5

export type AppearanceGradientSettings = {
  colors: string[]
  angle: number
  mix: number
}

export const AppearanceGradientSettingsSchema = Schema.Struct({
  colors: Schema.mutable(Schema.Array(Schema.String)),
  angle: Schema.Finite,
  mix: Schema.Finite,
})

export const AppearanceThemeVariantSchema = Schema.Literals(['light', 'dark'])

export type AppearanceThemeVariant = typeof AppearanceThemeVariantSchema.Type

/** Пользовательская тема: только якоря Prism, остальное генерирует движок. */
export type AppearanceThemeAnchors = {
  accent: string
  background: string
  foreground: string
  contrast: number
  gradient?: AppearanceGradientSettings
}

export const AppearanceThemeAnchorsSchema = Schema.Struct({
  accent: Schema.String,
  background: Schema.String,
  foreground: Schema.String,
  contrast: Schema.Finite,
  gradient: Schema.optionalKey(AppearanceGradientSettingsSchema),
})

export type AppearanceCustomTheme = {
  id: string
  name: string
  anchors: Record<AppearanceThemeVariant, AppearanceThemeAnchors>
}

export const AppearanceCustomThemeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  anchors: Schema.Struct({
    light: AppearanceThemeAnchorsSchema,
    dark: AppearanceThemeAnchorsSchema,
  }),
})

export const APPEARANCE_CUSTOM_THEME_NAME_MAX = 32
export const APPEARANCE_CUSTOM_THEME_LIMIT = 30

export type AppearanceThemeSelection = Record<AppearanceThemeVariant, string>

export const AppearanceThemeSelectionSchema = Schema.Struct({
  light: Schema.String,
  dark: Schema.String,
})

export type AppearanceSettings = {
  /** Светлая и тёмная темы выбираются по отдельности. */
  themeIds: AppearanceThemeSelection
  colorMode: AppearanceColorMode
  /** Масштаб интерфейса в процентах: 100 — исходный размер. */
  scale: number
  /** `null` использует градиент выбранной палитры. */
  gradient: AppearanceGradientSettings | null
  /** Темы, созданные пользователем; живут рядом с выбором темы. */
  customThemes: AppearanceCustomTheme[]
}

export const AppearanceSettingsSchema = Schema.Struct({
  themeIds: AppearanceThemeSelectionSchema,
  colorMode: AppearanceColorModeSchema,
  scale: Schema.Finite,
  gradient: Schema.Union([AppearanceGradientSettingsSchema, Schema.Null]),
  customThemes: Schema.mutable(Schema.Array(AppearanceCustomThemeSchema)),
})

export const DEFAULT_THEME_ID = 'monolit'

export const APPEARANCE_THEME_CONTRAST_MAX = 100

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeIds: { light: DEFAULT_THEME_ID, dark: DEFAULT_THEME_ID },
  colorMode: 'dark',
  scale: 100,
  gradient: null,
  customThemes: [],
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i
const UnknownAppearanceRecordSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
)

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
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) return null
  const gradient = decoded.value
  if (!Array.isArray(gradient.colors)) return null
  const colors = gradient.colors
    .map(normalizeGradientColor)
    .filter((color): color is string => color !== null)
    .slice(0, APPEARANCE_GRADIENT_MAX_COLORS)
  // Legacy one-stop tints remain a flat gradient; saturation is not Prism's mix.
  if (colors.length === 1 && 'saturation' in gradient) colors.push(colors[0]!)
  if (colors.length < APPEARANCE_GRADIENT_MIN_COLORS) return null
  const angle =
    typeof gradient.angle === 'number' && Number.isFinite(gradient.angle)
      ? ((Math.round(gradient.angle) % 360) + 360) % 360
      : 180
  const mix =
    typeof gradient.mix === 'number' && Number.isFinite(gradient.mix)
      ? Math.round(clamp(gradient.mix, 0, 100))
      : 60

  return { colors, angle, mix }
}

export function normalizeAppearanceColorMode(
  value: unknown,
  fallback: AppearanceColorMode = DEFAULT_APPEARANCE_SETTINGS.colorMode,
): AppearanceColorMode {
  return Option.getOrElse(
    Schema.decodeUnknownOption(AppearanceColorModeSchema)(value),
    () => fallback,
  )
}

export function normalizeAppearanceScale(
  value: unknown,
  fallback: number = DEFAULT_APPEARANCE_SETTINGS.scale,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = clamp(value, APPEARANCE_SCALE_MIN, APPEARANCE_SCALE_MAX)
  // The scale slider is a stop list, so keep stored values on its grid.
  const steps = Math.round(
    (clamped - APPEARANCE_SCALE_MIN) / APPEARANCE_SCALE_STEP,
  )
  return APPEARANCE_SCALE_MIN + steps * APPEARANCE_SCALE_STEP
}

export function cloneAppearanceCustomThemes(
  themes: AppearanceCustomTheme[],
): AppearanceCustomTheme[] {
  return themes.map((theme) => ({
    ...theme,
    anchors: {
      light: cloneAppearanceThemeAnchors(theme.anchors.light),
      dark: cloneAppearanceThemeAnchors(theme.anchors.dark),
    },
  }))
}

export function cloneAppearanceThemeAnchors(
  anchors: AppearanceThemeAnchors,
): AppearanceThemeAnchors {
  return anchors.gradient
    ? {
        ...anchors,
        gradient: { ...anchors.gradient, colors: [...anchors.gradient.colors] },
      }
    : { ...anchors }
}

export function normalizeAppearanceThemeAnchors(
  value: unknown,
): AppearanceThemeAnchors | null {
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) return null
  const anchors = decoded.value
  const accent = normalizeGradientColor(anchors.accent)
  const background = normalizeGradientColor(anchors.background)
  const foreground = normalizeGradientColor(anchors.foreground)
  if (!accent || !background || !foreground) return null
  const contrast =
    typeof anchors.contrast === 'number' && Number.isFinite(anchors.contrast)
      ? Math.round(clamp(anchors.contrast, 0, APPEARANCE_THEME_CONTRAST_MAX))
      : null
  if (contrast === null) return null
  const gradient = normalizeAppearanceGradientSettings(anchors.gradient)
  return gradient
    ? { accent, background, foreground, contrast, gradient }
    : { accent, background, foreground, contrast }
}

function normalizeCustomTheme(value: unknown): AppearanceCustomTheme | null {
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) return null
  const theme = decoded.value
  const id = typeof theme.id === 'string' ? theme.id.trim() : ''
  const name = typeof theme.name === 'string' ? theme.name.trim() : ''
  if (!id || !name) return null
  const anchors = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    theme.anchors,
  )
  if (Option.isNone(anchors)) return null
  const light = normalizeAppearanceThemeAnchors(anchors.value.light)
  const dark = normalizeAppearanceThemeAnchors(anchors.value.dark)
  if (!light || !dark) return null
  return {
    id: id.slice(0, 64),
    name: name.slice(0, APPEARANCE_CUSTOM_THEME_NAME_MAX),
    anchors: { light, dark },
  }
}

export function normalizeAppearanceCustomThemes(
  value: unknown,
): AppearanceCustomTheme[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const themes: AppearanceCustomTheme[] = []
  for (const entry of value) {
    const theme = normalizeCustomTheme(entry)
    if (!theme || seen.has(theme.id)) continue
    seen.add(theme.id)
    themes.push(theme)
    if (themes.length >= APPEARANCE_CUSTOM_THEME_LIMIT) break
  }
  return themes
}

function normalizeThemeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id.length > 0 ? id : null
}

/**
 * Светлая и тёмная темы хранятся раздельно. Старые настройки с одним `themeId`
 * подставляют его в оба варианта.
 */
export function normalizeAppearanceThemeIds(
  value: unknown,
  legacyThemeId?: unknown,
  defaults: AppearanceThemeSelection = DEFAULT_APPEARANCE_SETTINGS.themeIds,
): AppearanceThemeSelection {
  const legacy = normalizeThemeId(legacyThemeId)
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) {
    return legacy ? { light: legacy, dark: legacy } : { ...defaults }
  }
  const selection = decoded.value
  return {
    light: normalizeThemeId(selection.light) ?? legacy ?? defaults.light,
    dark: normalizeThemeId(selection.dark) ?? legacy ?? defaults.dark,
  }
}

export function normalizeAppearanceSettings(
  value: unknown,
  defaults: AppearanceSettings = DEFAULT_APPEARANCE_SETTINGS,
): AppearanceSettings {
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) {
    return {
      ...defaults,
      themeIds: { ...defaults.themeIds },
      gradient: cloneGradient(defaults.gradient),
      customThemes: cloneAppearanceCustomThemes(defaults.customThemes),
    }
  }
  const settings = decoded.value
  return {
    themeIds: normalizeAppearanceThemeIds(
      settings.themeIds,
      settings.themeId,
      defaults.themeIds,
    ),
    colorMode: normalizeAppearanceColorMode(
      settings.colorMode,
      defaults.colorMode,
    ),
    scale: normalizeAppearanceScale(settings.scale, defaults.scale),
    gradient:
      settings.gradient === null
        ? null
        : (normalizeAppearanceGradientSettings(settings.gradient) ??
          cloneGradient(defaults.gradient)),
    customThemes:
      'customThemes' in settings
        ? normalizeAppearanceCustomThemes(settings.customThemes)
        : cloneAppearanceCustomThemes(defaults.customThemes),
  }
}

export type AppearanceSettingsPatch = Partial<AppearanceSettings>

export function normalizeAppearanceSettingsPatch(
  value: unknown,
): AppearanceSettingsPatch | undefined {
  const decoded = Schema.decodeUnknownOption(UnknownAppearanceRecordSchema)(
    value,
  )
  if (Option.isNone(decoded)) return undefined
  const patch = decoded.value
  const next: AppearanceSettingsPatch = {}
  if ('themeIds' in patch) {
    next.themeIds = normalizeAppearanceThemeIds(patch.themeIds)
  } else if ('themeId' in patch) {
    const legacy = normalizeThemeId(patch.themeId)
    if (legacy) next.themeIds = { light: legacy, dark: legacy }
  }
  if ('colorMode' in patch) {
    next.colorMode = normalizeAppearanceColorMode(patch.colorMode)
  }
  if (
    'scale' in patch &&
    typeof patch.scale === 'number' &&
    Number.isFinite(patch.scale)
  ) {
    next.scale = normalizeAppearanceScale(patch.scale)
  }
  if ('gradient' in patch) {
    if (patch.gradient === null) {
      next.gradient = null
    } else {
      const gradient = normalizeAppearanceGradientSettings(patch.gradient)
      if (gradient) next.gradient = gradient
    }
  }
  if ('customThemes' in patch) {
    next.customThemes = normalizeAppearanceCustomThemes(patch.customThemes)
  }
  return Object.keys(next).length > 0 ? next : undefined
}
