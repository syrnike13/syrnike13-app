import type {
  AppearanceCustomTheme,
  AppearanceSettings,
  AppearanceThemeAnchors,
  AppearanceThemeVariant,
} from '@syrnike13/platform'
import {
  DEFAULT_THEME_ID,
  applyThemeToDocument,
  getThemeById,
  listThemes,
  resolveThemeVariant,
  type ThemeDefinition,
} from '@syrnike13/ui/tokens'

/** Пользовательская тема описывается теми же якорями Prism, что и каталожная. */
export function customThemeToDefinition(
  theme: AppearanceCustomTheme,
): ThemeDefinition {
  return { id: theme.id, anchors: theme.anchors }
}

export function listCustomThemeDefinitions(
  settings: Pick<AppearanceSettings, 'customThemes'>,
): ThemeDefinition[] {
  return settings.customThemes.map(customThemeToDefinition)
}

/** Каталожные темы, затем пользовательские: порядок задаёт сетку в настройках. */
export function listAppearanceThemes(
  settings: Pick<AppearanceSettings, 'customThemes'>,
): ThemeDefinition[] {
  return [...listThemes(), ...listCustomThemeDefinitions(settings)]
}

/** Тема, выбранная для конкретного варианта: светлого или тёмного. */
export function resolveThemeForVariant(
  settings: Pick<AppearanceSettings, 'themeIds' | 'customThemes'>,
  variant: AppearanceThemeVariant,
): ThemeDefinition {
  const themeId = settings.themeIds[variant]
  const custom = settings.customThemes.find((theme) => theme.id === themeId)
  if (custom) return customThemeToDefinition(custom)
  return getThemeById(themeId)
}

/**
 * Единственная точка применения темы в web: подставляет тему под вариант.
 * Любой вызов `applyThemeToDocument` без резолвера сбрасывает тему на monolit.
 */
export function applyAppearanceTheme(
  settings: AppearanceSettings,
  prefersDark?: boolean,
): void {
  applyThemeToDocument(settings, prefersDark, undefined, undefined, (variant) =>
    resolveThemeForVariant(settings, variant),
  )
}

/** Тема, которая сейчас применена к документу с учётом `colorMode`. */
export function resolveActiveTheme(
  settings: Pick<AppearanceSettings, 'themeIds' | 'customThemes' | 'colorMode'>,
  prefersDark: boolean,
): ThemeDefinition {
  const variant = resolveThemeVariant(settings, prefersDark)
  return resolveThemeForVariant(settings, variant)
}

export function isCustomThemeId(
  settings: Pick<AppearanceSettings, 'customThemes'>,
  themeId: string,
): boolean {
  return settings.customThemes.some((theme) => theme.id === themeId)
}

export function findCustomTheme(
  settings: Pick<AppearanceSettings, 'customThemes'>,
  themeId: string,
): AppearanceCustomTheme | undefined {
  return settings.customThemes.find((theme) => theme.id === themeId)
}

export const CUSTOM_THEME_ID_PREFIX = 'custom-'

export function createCustomThemeId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 12)
  return `${CUSTOM_THEME_ID_PREFIX}${random}`
}

const DEFAULT_LIGHT_CONTRAST = 45
const DEFAULT_DARK_CONTRAST = 62

export function anchorsForNewTheme(): AppearanceCustomTheme['anchors'] {
  return {
    light: { ...getDefaultAnchors('light') },
    dark: { ...getDefaultAnchors('dark') },
  }
}

export function getDefaultAnchors(
  variant: AppearanceThemeVariant,
): AppearanceThemeAnchors {
  const base = getThemeById(DEFAULT_THEME_ID).anchors[variant]
  return {
    accent: base.accent,
    background: base.background,
    foreground: base.foreground,
    contrast:
      base.contrast ??
      (variant === 'light' ? DEFAULT_LIGHT_CONTRAST : DEFAULT_DARK_CONTRAST),
  }
}

/** Случайная тема: та же раскладка, новая цветовая семья. */
export function randomThemeAnchors(): AppearanceCustomTheme['anchors'] {
  const hue = Math.random() * 360
  return {
    light: randomVariantAnchors('light', hue),
    dark: randomVariantAnchors('dark', hue),
  }
}

function randomVariantAnchors(
  variant: AppearanceThemeVariant,
  hue: number,
): AppearanceThemeAnchors {
  const accentLightness = variant === 'light' ? 42 : 62
  const backgroundLightness = variant === 'light' ? 97 : 8
  const foregroundLightness = variant === 'light' ? 13 : 93
  return {
    accent: hslToHex(hue, 58, accentLightness),
    background: hslToHex(hue, 26, backgroundLightness),
    foreground: hslToHex(hue, 30, foregroundLightness),
    contrast:
      variant === 'light' ? DEFAULT_LIGHT_CONTRAST : DEFAULT_DARK_CONTRAST,
  }
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const hueSection = hue / 60
  const x = chroma * (1 - Math.abs((hueSection % 2) - 1))
  const [r, g, b] =
    hueSection < 1
      ? [chroma, x, 0]
      : hueSection < 2
        ? [x, chroma, 0]
        : hueSection < 3
          ? [0, chroma, x]
          : hueSection < 4
            ? [0, x, chroma]
            : hueSection < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const m = l - chroma / 2
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}
