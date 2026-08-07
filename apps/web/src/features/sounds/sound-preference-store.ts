import { useSyncExternalStore } from 'react'
import {
  DEFAULT_DESKTOP_SOUND_SETTINGS,
  DesktopSoundSettingsSchema,
  normalizeDesktopSoundSettings,
  normalizeDesktopSoundSettingsPatch,
  type DesktopSoundSettings,
  type DesktopSoundSettingsPatch,
} from '@syrnike13/platform'
import { Effect, Option, Schema, SchemaTransformation } from 'effect'

import {
  loadDesktopLocalSettingsEffect,
  updateDesktopLocalSettingsEffect,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const SOUND_PREFERENCES_STORAGE_KEY = 'syrnike13-sound-preferences'
export const DEFAULT_SOUND_PREFERENCES = DEFAULT_DESKTOP_SOUND_SETTINGS
const UnknownSoundPreferencesJsonSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
)
const SoundPreferencesJsonSchema = Schema.fromJsonString(
  DesktopSoundSettingsSchema,
)

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
    return normalizeSoundPreferences(
      raw
        ? Option.getOrUndefined(
            Schema.decodeUnknownOption(UnknownSoundPreferencesJsonSchema)(raw),
          )
        : null,
    )
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
    Effect.runFork(
      updateDesktopLocalSettingsEffect({ sounds: state }).pipe(Effect.ignore),
    )
    return
  }
  try {
    localStorage.setItem(
      SOUND_PREFERENCES_STORAGE_KEY,
      Schema.encodeSync(SoundPreferencesJsonSchema)(state),
    )
  } catch {
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}

function patch(partial: DesktopSoundSettingsPatch) {
  state = normalizeSoundPreferences({
    ...state,
    ...partial,
    eventVolumes: partial.eventVolumes
      ? { ...state.eventVolumes, ...partial.eventVolumes }
      : state.eventVolumes,
  })
  stateRevision += 1
  persist()
  emit()
}

export const hydrateSoundPreferencesFromDesktopEffect = Effect.fn(
  'soundPreferences.hydrateFromDesktop',
)(function*() {
  const revision = stateRevision
  const settings = yield* loadDesktopLocalSettingsEffect()
  if (!settings || revision !== stateRevision) return
  yield* Effect.sync(() => {
    state = normalizeSoundPreferences(settings.sounds)
    emit()
  })
})

export function hydrateSoundPreferencesFromDesktop() {
  return Effect.runPromise(hydrateSoundPreferencesFromDesktopEffect())
}

export const soundPreferenceStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => state,

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

  setEventVolume(eventId: string, volume: number) {
    const next = normalizeSoundPreferencesPatch({
      eventVolumes: { [eventId]: volume },
    })?.eventVolumes?.[eventId]
    if (next == null || state.eventVolumes[eventId] === next) return
    patch({ eventVolumes: { [eventId]: next } })
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

if (typeof window !== 'undefined') {
  Effect.runFork(hydrateSoundPreferencesFromDesktopEffect())
}
