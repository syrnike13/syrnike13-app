import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { applyRemoteAudioGain } from '#/features/voice/remote-audio-gain'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'

export function remoteAudioElementVolume(
  userVolume: number,
  outputVolume: number,
  muted: boolean,
  autoBalanceGain = 1,
) {
  if (muted) return 0
  return Math.min(
    1,
    Math.max(0, userVolume) *
      Math.max(0, outputVolume) *
      Math.max(0, autoBalanceGain),
  )
}

export function normalizeAutoBalanceStrength(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, Number(value.toFixed(3))))
}

export function remoteAutoBalanceGain(
  inputLevel: number,
  strength: number,
  enabled: boolean,
) {
  if (!enabled) return 1
  if (!Number.isFinite(inputLevel) || inputLevel <= 0) return 1

  const normalizedStrength = normalizeAutoBalanceStrength(strength)
  if (normalizedStrength === 0) return 1

  const targetLevel = 0.35
  const gain = Math.pow(targetLevel / Math.max(0.03, inputLevel), normalizedStrength)
  return Math.min(2.5, Math.max(0.6, Number(gain.toFixed(3))))
}

export function applyRemoteAudioElement(
  element: HTMLAudioElement,
  globallyDeafened: boolean,
) {
  const userId = element.dataset.livekitUserId
  if (!userId) return

  const isStreamAudio = element.dataset.livekitAudioSource === 'stream'
  const channelMuted = isStreamAudio
    ? voiceListenerStore.getStreamMuted(userId)
    : voiceListenerStore.getUserMuted(userId)
  const muted = globallyDeafened || channelMuted
  element.muted = muted
  const channelVolume = isStreamAudio
    ? voiceListenerStore.getStreamVolume(userId)
    : voiceListenerStore.getUserVolume(userId)
  const prefs = voicePreferenceStore.getState()
  const autoBalanceGain = isStreamAudio
    ? 1
    : remoteAutoBalanceGain(
        Number(element.dataset.livekitAudioLevel ?? 0),
        prefs.autoBalanceStrength,
        prefs.autoBalanceEnabled,
      )
  const gainApplied = applyRemoteAudioGain(
    element,
    muted ? 0 : autoBalanceGain,
  )
  element.volume = remoteAudioElementVolume(
    channelVolume,
    prefs.outputVolume,
    muted,
    gainApplied ? 1 : autoBalanceGain,
  )
}

export function applyAllRemoteAudio(globallyDeafened: boolean) {
  for (const element of document.querySelectorAll<HTMLAudioElement>(
    'audio[data-livekit="remote"]',
  )) {
    applyRemoteAudioElement(element, globallyDeafened)
  }
}
