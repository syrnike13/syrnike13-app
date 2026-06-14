import { useSyncExternalStore } from 'react'
import {
  DEFAULT_DESKTOP_SOUND_SETTINGS,
  normalizeDesktopSoundSettings,
  normalizeDesktopSoundSettingsPatch,
  type DesktopSoundSettings,
  type DesktopSoundSettingsPatch,
} from '@syrnike13/platform'

import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const SOUND_PREFERENCES_STORAGE_KEY = 'syrnike13-sound-preferences'
export const DEFAULT_SOUND_PREFERENCES = DEFAULT_DESKTOP_SOUND_SETTINGS

export function normalizeSoundPreferences(value: unknown) {
  return normalizeDesktopSoundSettings(value)
}

export function normalizeSoundPreferencesPatch(value: unknown) {
  return normalizeDesktopSoundSettingsPatch(value)
}

function loadState(): DesktopSoundSettings {
  if (typeof window === 'undefined' || getSyrnikeDesktop()) {
    return normalizeSoundPreferences(null)
  }
  try {
    const raw = localStorage.getItem(SOUND_PREFERENCES_STORAGE_KEY)
    return normalizeSoundPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeSoundPreferences(null)
  }
}

let state = loadState()
let stateRevision = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  if (typeof window === 'undefined') return
  if (getSyrnikeDesktop()) {
    void updateDesktopLocalSettings({ sounds: state })
    return
  }
  try {
    localStorage.setItem(SOUND_PREFERENCES_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}

function patch(partial: DesktopSoundSettingsPatch) {
  state = normalizeSoundPreferences({ ...state, ...partial })
  stateRevision += 1
  persist()
  emit()
}

export async function hydrateSoundPreferencesFromDesktop() {
  const revision = stateRevision
  const settings = await loadDesktopLocalSettings()
  if (!settings || revision !== stateRevision) return
  state = normalizeSoundPreferences(settings.sounds)
  emit()
}

export const soundPreferenceStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => ({ ...state }),

  setEnabled(enabled: boolean) {
    if (state.enabled === enabled) return
    patch({ enabled })
  },

  setAuthorPackId(authorPackId: DesktopSoundSettings['authorPackId']) {
    if (state.authorPackId === authorPackId) return
    patch({ authorPackId })
  },

  setVolume(volume: number) {
    const next = normalizeSoundPreferencesPatch({ volume })?.volume
    if (next == null || state.volume === next) return
    patch({ volume: next })
  },

  setEasterEnabled(easterEnabled: boolean) {
    if (state.easterEnabled === easterEnabled) return
    patch({ easterEnabled })
  },
}

export function useSoundPreferences() {
  return useSyncExternalStore(
    soundPreferenceStore.subscribe,
    () => soundPreferenceStore.getState(),
    () => soundPreferenceStore.getState(),
  )
}

void hydrateSoundPreferencesFromDesktop()
