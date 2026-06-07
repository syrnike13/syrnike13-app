import type { VoicePreferenceState } from './voice-preference-store'

export type VoicePreferenceEffectFlags = {
  devicesChanged: boolean
  micProcessingChanged: boolean
  remoteAudioChanged: boolean
}

export function voicePreferenceEffectFlags(
  previous: VoicePreferenceState,
  next: VoicePreferenceState,
): VoicePreferenceEffectFlags {
  return {
    devicesChanged:
      previous.preferredAudioInputDevice !== next.preferredAudioInputDevice ||
      previous.preferredAudioOutputDevice !== next.preferredAudioOutputDevice,
    micProcessingChanged:
      previous.echoCancellation !== next.echoCancellation ||
      previous.voiceGateEnabled !== next.voiceGateEnabled ||
      previous.voiceGateThresholdDb !== next.voiceGateThresholdDb ||
      previous.voiceGateAutoThreshold !== next.voiceGateAutoThreshold ||
      previous.inputVolume !== next.inputVolume,
    remoteAudioChanged:
      previous.outputVolume !== next.outputVolume ||
      previous.autoBalanceEnabled !== next.autoBalanceEnabled ||
      previous.autoBalanceStrength !== next.autoBalanceStrength,
  }
}
