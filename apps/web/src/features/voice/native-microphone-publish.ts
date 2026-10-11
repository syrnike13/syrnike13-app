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

export function shouldUseNativeMicrophone() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
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
