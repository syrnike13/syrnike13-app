import {
  APPEARANCE_CUSTOM_THEME_LIMIT,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_THEME_ID,
  AppearanceSettingsSchema,
  cloneAppearanceCustomThemes,
  normalizeAppearanceColorMode,
  normalizeAppearanceSettings,
  type AppearanceColorMode,
  type AppearanceCustomTheme,
  type AppearanceGradientSettings,
  type AppearanceSettings,
  type AppearanceThemeVariant,
} from '@syrnike13/platform'
import { Effect, Option, Schema, SchemaTransformation } from 'effect'

import { listThemes } from '@syrnike13/ui/tokens'
import { applyAppearanceScale } from '#/features/appearance/appearance-scale'
import { applyAppearanceTheme } from '#/features/appearance/appearance-themes'
import {
  loadDesktopLocalSettingsEffect,
  updateDesktopLocalSettingsEffect,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const APPEARANCE_STORAGE_KEY = 'syrnike13-appearance'
const LEGACY_THEME_STORAGE_KEY = 'theme'
const UnknownAppearanceJsonSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
)
const AppearanceSettingsJsonSchema = Schema.fromJsonString(
  AppearanceSettingsSchema,
)

function knownThemeIds(settings: AppearanceSettings): Set<string> {
  return new Set([
    ...listThemes().map((theme) => theme.id),
    ...settings.customThemes.map((theme) => theme.id),
  ])
}

function withKnownThemeIds(settings: AppearanceSettings): AppearanceSettings {
  const known = knownThemeIds(settings)
  const light = known.has(settings.themeIds.light)
    ? settings.themeIds.light
    : DEFAULT_THEME_ID
  const dark = known.has(settings.themeIds.dark)
    ? settings.themeIds.dark
    : DEFAULT_THEME_ID
  return light === settings.themeIds.light && dark === settings.themeIds.dark
    ? settings
    : { ...settings, themeIds: { light, dark } }
}

function migrateLegacyTheme(): AppearanceSettings | null {
  if (typeof window === 'undefined') return null
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    if (!legacy) return null
    const colorMode = normalizeAppearanceColorMode(legacy, 'dark')
    localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
    return {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeIds: { light: DEFAULT_THEME_ID, dark: DEFAULT_THEME_ID },
      colorMode,
    }
  } catch {
    return null
  }
}

export function readStoredAppearanceSettings(): AppearanceSettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_APPEARANCE_SETTINGS }
  }

  if (getSyrnikeDesktop()) {
    return { ...DEFAULT_APPEARANCE_SETTINGS }
  }

  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    if (raw) {
      return withKnownThemeIds(
        normalizeAppearanceSettings(
          Option.getOrUndefined(
            Schema.decodeUnknownOption(UnknownAppearanceJsonSchema)(raw),
          ),
        ),
      )
    }
    const migrated = migrateLegacyTheme()
    if (migrated) {
      localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        Schema.encodeSync(AppearanceSettingsJsonSchema)(migrated),
      )
      return migrated
    }
  } catch {
    // private mode / corrupt storage
  }

  return { ...DEFAULT_APPEARANCE_SETTINGS }
}

function loadState(): AppearanceSettings {
  return readStoredAppearanceSettings()
}

let state = loadState()
let stateRevision = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function cloneSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    ...settings,
    themeIds: { ...settings.themeIds },
    gradient: settings.gradient
      ? { ...settings.gradient, colors: [...settings.gradient.colors] }
      : null,
    customThemes: cloneAppearanceCustomThemes(settings.customThemes),
  }
}

function persist() {
  if (typeof window === 'undefined') return
  if (getSyrnikeDesktop()) {
    Effect.runFork(
      updateDesktopLocalSettingsEffect({ appearance: state }).pipe(
        Effect.ignore,
      ),
    )
    return
  }
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      Schema.encodeSync(AppearanceSettingsJsonSchema)(state),
    )
  } catch {
    // quota / private mode
  }
}

function applyAppearance(settings: AppearanceSettings) {
  applyAppearanceTheme(settings)
  applyAppearanceScale(settings.scale)
}

function patch(
  partial: Partial<AppearanceSettings>,
  options: { persist?: boolean } = {},
) {
  state = withKnownThemeIds(
    normalizeAppearanceSettings({ ...state, ...partial }),
  )
  stateRevision += 1
  if (options.persist !== false) persist()
  applyAppearance(state)
  emit()
}

export const hydrateAppearanceSettingsFromDesktopEffect = Effect.fn(
  'appearanceSettings.hydrateFromDesktop',
)(function*() {
  const revision = stateRevision
  const settings = yield* loadDesktopLocalSettingsEffect()
  if (!settings || revision !== stateRevision) return
  yield* Effect.sync(() => {
    state = withKnownThemeIds(normalizeAppearanceSettings(settings.appearance))
    applyAppearance(state)
    emit()
  })
})

export const appearanceSettingsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => cloneSettings(state),

  setThemeId(themeId: string, variant?: AppearanceThemeVariant) {
    const next = variant
      ? { ...state.themeIds, [variant]: themeId }
      : { light: themeId, dark: themeId }
    if (next.light === state.themeIds.light && next.dark === state.themeIds.dark) {
      return
    }
    patch({ themeIds: next })
  },

  setColorMode(colorMode: AppearanceColorMode) {
    if (state.colorMode === colorMode) return
    patch({ colorMode })
  },

  setScale(scale: number) {
    if (state.scale === scale) return
    patch({ scale })
  },

  previewGradient(gradient: AppearanceGradientSettings) {
    patch({ gradient }, { persist: false })
  },

  setGradient(gradient: AppearanceGradientSettings | null) {
    patch({ gradient })
  },

  setSettings(settings: AppearanceSettings) {
    patch(normalizeAppearanceSettings(settings))
  },

  /** `false`, если тема не сохранилась: достигнут лимит или она невалидна. */
  addCustomTheme(theme: AppearanceCustomTheme): boolean {
    if (state.customThemes.length >= APPEARANCE_CUSTOM_THEME_LIMIT) return false
    patch({ customThemes: [...state.customThemes, theme] })
    return state.customThemes.some((custom) => custom.id === theme.id)
  },

  updateCustomTheme(
    themeId: string,
    update: (theme: AppearanceCustomTheme) => AppearanceCustomTheme,
  ) {
    const customThemes = state.customThemes.map((theme) =>
      theme.id === themeId ? update(theme) : theme,
    )
    patch({ customThemes })
  },

  removeCustomTheme(themeId: string) {
    const customThemes = state.customThemes.filter(
      (theme) => theme.id !== themeId,
    )
    if (customThemes.length === state.customThemes.length) return
    patch({
      customThemes,
      themeIds: {
        light:
          state.themeIds.light === themeId ? DEFAULT_THEME_ID : state.themeIds.light,
        dark:
          state.themeIds.dark === themeId ? DEFAULT_THEME_ID : state.themeIds.dark,
      },
    })
  },
}

Effect.runFork(hydrateAppearanceSettingsFromDesktopEffect())
