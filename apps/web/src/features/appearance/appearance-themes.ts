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
  readSystemPrefersDark,
  type ThemeDefinition,
} from '@syrnike13/ui/tokens'
import { hexToPickerHsv } from '#/features/appearance/theme-color-picker-model'

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
  prefersDark = readSystemPrefersDark(),
): void {
  const variant = resolveThemeVariant(settings, prefersDark)
  applyThemeToDocument(
    settings,
    prefersDark,
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
  const accent = hslToHex(hue, 58, variant === 'light' ? 42 : 62)
  return {
    accent,
    ...deriveSurfaceAnchors(variant, accent),
    contrast:
      variant === 'light' ? DEFAULT_LIGHT_CONTRAST : DEFAULT_DARK_CONTRAST,
  }
}

/**
 * Фон и текст, подобранные под один акцентный цвет: тот же оттенок, фиксированная
 * светлота для светлого/тёмного варианта. Серый акцент даёт нейтральные поверхности.
 */
export function deriveSurfaceAnchors(
  variant: AppearanceThemeVariant,
  accent: string,
): Pick<AppearanceThemeAnchors, 'background' | 'foreground'> {
  const { hue, saturation } = hexToPickerHsv(accent)
  const tint = Math.min(1, saturation / 0.5)
  return {
    background: hslToHex(hue, 26 * tint, variant === 'light' ? 97 : 8),
    foreground: hslToHex(hue, 30 * tint, variant === 'light' ? 13 : 93),
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
