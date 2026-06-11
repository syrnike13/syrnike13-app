export type AppearanceColorMode = 'light' | 'dark' | 'system'

export type AppearanceSettings = {
  themeId: string
  colorMode: AppearanceColorMode
}

export const DEFAULT_THEME_ID = 'syrnike'

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeId: DEFAULT_THEME_ID,
  colorMode: 'dark',
}

const COLOR_MODES = new Set<AppearanceColorMode>(['light', 'dark', 'system'])

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
    return { ...defaults }
  }
  const settings = value as Record<string, unknown>
  const themeId =
    typeof settings.themeId === 'string' && settings.themeId.trim().length > 0
      ? settings.themeId.trim()
      : defaults.themeId
  return {
    themeId,
    colorMode: normalizeAppearanceColorMode(settings.colorMode, defaults.colorMode),
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
  return Object.keys(next).length > 0 ? next : undefined
}
