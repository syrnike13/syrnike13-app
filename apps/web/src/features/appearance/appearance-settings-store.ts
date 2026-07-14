import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_THEME_ID,
  normalizeAppearanceColorMode,
  normalizeAppearanceSettings,
  type AppearanceColorMode,
  type AppearanceGradientSettings,
  type AppearanceSettings,
} from '@syrnike13/platform'

import { applyThemeToDocument } from '#/features/appearance/apply-theme'
import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const APPEARANCE_STORAGE_KEY = 'syrnike13-appearance'
const LEGACY_THEME_STORAGE_KEY = 'theme'

function migrateLegacyTheme(): AppearanceSettings | null {
  if (typeof window === 'undefined') return null
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    if (!legacy) return null
    const colorMode = normalizeAppearanceColorMode(legacy, 'dark')
    localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
    return {
      ...DEFAULT_APPEARANCE_SETTINGS,
      themeId: DEFAULT_THEME_ID,
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
      return normalizeAppearanceSettings(JSON.parse(raw) as unknown)
    }
    const migrated = migrateLegacyTheme()
    if (migrated) {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(migrated))
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
    gradient: settings.gradient
      ? { ...settings.gradient, colors: [...settings.gradient.colors] }
      : null,
  }
}

function persist() {
  if (typeof window === 'undefined') return
  if (getSyrnikeDesktop()) {
    void updateDesktopLocalSettings({ appearance: state })
    return
  }
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota / private mode
  }
}

function patch(
  partial: Partial<AppearanceSettings>,
  options: { persist?: boolean } = {},
) {
  state = normalizeAppearanceSettings({ ...state, ...partial })
  stateRevision += 1
  if (options.persist !== false) persist()
  applyThemeToDocument(state)
  emit()
}

export async function hydrateAppearanceSettingsFromDesktop() {
  const revision = stateRevision
  const settings = await loadDesktopLocalSettings()
  if (!settings || revision !== stateRevision) return
  state = normalizeAppearanceSettings(settings.appearance)
  applyThemeToDocument(state)
  emit()
}

export const appearanceSettingsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => cloneSettings(state),

  setThemeId(themeId: string) {
    if (state.themeId === themeId) return
    patch({ themeId })
  },

  setColorMode(colorMode: AppearanceColorMode) {
    if (state.colorMode === colorMode) return
    patch({ colorMode })
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
}

export function useAppearanceSettingsSnapshot() {
  return appearanceSettingsStore.getState()
}

void hydrateAppearanceSettingsFromDesktop()
