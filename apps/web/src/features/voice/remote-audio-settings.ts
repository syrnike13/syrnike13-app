import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

export function remoteAudioElementVolume(
  userVolume: number,
  outputVolume: number,
  muted: boolean,
) {
  if (muted) return 0
  return Math.min(1, Math.max(0, userVolume) * Math.max(0, outputVolume))
}

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
  element.volume = remoteAudioElementVolume(userVolume, outputVolume, muted)
}

export function applyAllRemoteAudio(globallyDeafened: boolean) {
  for (const element of document.querySelectorAll<HTMLAudioElement>(
    'audio[data-livekit="remote"]',
  )) {
    applyRemoteAudioElement(element, globallyDeafened)
  }
}
