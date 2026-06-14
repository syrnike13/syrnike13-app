import type { DesktopSoundSettings } from '@syrnike13/platform'

import type { SoundEventId } from './sound-events'
import { resolveSoundClip, type SoundEventPackId } from './sound-packs'
import { soundPreferenceStore } from './sound-preference-store'
import { soundRuntimeConfigStore } from './sound-runtime-config'

type AudioLike = {
  volume: number
  preload: string
  play: () => Promise<unknown> | unknown
}

type SoundPlayerDeps = {
  createAudio: (src: string) => AudioLike
  getPreferences: () => DesktopSoundSettings
  getEventPackId: () => SoundEventPackId | null
  random?: () => number
}

export function createSoundPlayer({
  createAudio,
  getPreferences,
  getEventPackId,
  random = Math.random,
}: SoundPlayerDeps) {
  return {
    play(eventId: SoundEventId) {
      const preferences = getPreferences()
      if (!preferences.enabled) return

      const clip = resolveSoundClip({
        eventId,
        authorPackId: preferences.authorPackId,
        eventPackId: getEventPackId(),
        easterEnabled: preferences.easterEnabled,
        random,
      })
      if (!clip) return

      const audio = createAudio(clip.src)
      const eventVolume = preferences.eventVolumes[eventId] ?? 1
      audio.preload = 'auto'
      audio.volume = Math.max(
        0,
        Math.min(1, preferences.volume * eventVolume * (clip.volume ?? 1)),
      )

      try {
        void Promise.resolve(audio.play()).catch(() => {})
      } catch {
        // Browser autoplay policy or a missing asset must not break the UI.
      }
    },
  }
}

function createBrowserAudio(src: string): AudioLike {
  return new Audio(src)
}

export const soundPlayer = createSoundPlayer({
  createAudio: createBrowserAudio,
  getPreferences: () => soundPreferenceStore.getState(),
  getEventPackId: () => soundRuntimeConfigStore.getState().eventPackId,
})

export function playUiSound(eventId: SoundEventId) {
  soundPlayer.play(eventId)
}
