import {
  VOICE_USER_VOLUME_MAX,
  voiceListenerStore,
} from '#/features/voice/voice-listener-store'
import {
  voicePreferenceStore,
  VOICE_OUTPUT_VOLUME_MAX,
} from '#/features/voice/voice-preference-store'

export function applyRemoteAudioElement(
  element: HTMLAudioElement,
  globallyDeafened: boolean,
) {
  const userId = element.dataset.livekitUserId
  if (!userId) return

  const userMuted = voiceListenerStore.getUserMuted(userId)
  const muted = globallyDeafened || userMuted
  element.muted = muted
  const userVolume = voiceListenerStore.getUserVolume(userId)
  const outputVolume = voicePreferenceStore.getOutputVolume()
  const combined = Math.min(
    1,
    (userVolume / VOICE_USER_VOLUME_MAX) *
      (outputVolume / VOICE_OUTPUT_VOLUME_MAX),
  )
  element.volume = muted ? 0 : combined
}

export function applyAllRemoteAudio(globallyDeafened: boolean) {
  for (const element of document.querySelectorAll<HTMLAudioElement>(
    'audio[data-livekit="remote"]',
  )) {
    applyRemoteAudioElement(element, globallyDeafened)
  }
}
