import type { MediaEngineMicProcessingParams } from '@syrnike13/platform'

import {
  setMediaEngineRemoteAudioOutputDevice,
} from '#/features/voice/media-engine-remote-audio'
import type { MediaEngineVoiceSession } from '#/features/voice/media-engine-voice'
import type { VoicePreferenceState } from '#/features/voice/voice-preference-store'
import type { NoiseSuppressionMode } from '#/features/voice/voice-preference-types'

export function toEngineMicProcessingParams(
  prefs: VoicePreferenceState,
): MediaEngineMicProcessingParams {
  return {
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThreshold: prefs.voiceGateThreshold,
    echoCancellation: prefs.echoCancellation,
    autoGainControl: prefs.autoGainControl,
    noiseSuppression: prefs.noiseSuppression as NoiseSuppressionMode,
  }
}

export async function applyEngineVoiceDevices(
  session: MediaEngineVoiceSession,
  prefs: VoicePreferenceState,
) {
  await session.setMicDevice(prefs.preferredAudioInputDevice)
  setMediaEngineRemoteAudioOutputDevice(prefs.preferredAudioOutputDevice)
}

export async function applyEngineMicProcessing(
  session: MediaEngineVoiceSession,
  prefs: VoicePreferenceState,
) {
  await session.setMicProcessing(toEngineMicProcessingParams(prefs))
}

export async function finishEngineLocalVoiceSetup(
  session: MediaEngineVoiceSession,
  prefs: VoicePreferenceState,
) {
  await applyEngineMicProcessing(session, prefs)
  await applyEngineVoiceDevices(session, prefs)
}
