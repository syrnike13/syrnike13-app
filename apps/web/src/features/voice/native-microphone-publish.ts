import { getSyrnikeDesktop } from '#/platform/runtime'

import type { VoicePreferenceState } from '#/features/voice/voice-preference-store'

type NativeMicrophonePreferences = Pick<
  VoicePreferenceState,
  | 'bypassSystemAudioInputProcessing'
  | 'automaticGainControl'
  | 'noiseSuppression'
  | 'echoCancellation'
  | 'inputVolume'
  | 'voiceGateEnabled'
  | 'voiceGateThresholdDb'
  | 'voiceGateAutoThreshold'
>

export type NativeMicrophoneRecoveryState = {
  voiceConnected: boolean
  wantsMic: boolean
  deafened: boolean
  selfMonitoringActive: boolean
}

export function shouldUseNativeMicrophone() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

export function shouldRestartNativeMicrophonePublisher(
  state: NativeMicrophoneRecoveryState,
) {
  return (
    state.voiceConnected &&
    state.wantsMic &&
    !state.deafened &&
    !state.selfMonitoringActive
  )
}

export function nativeMicrophonePipelineConfig(
  prefs: NativeMicrophonePreferences,
  deviceId?: string,
) {
  return {
    deviceId: deviceId ?? null,
    bypassSystemAudioInputProcessing:
      prefs.bypassSystemAudioInputProcessing,
    automaticGainControl: prefs.automaticGainControl,
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
  }
}
