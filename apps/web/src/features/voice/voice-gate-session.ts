import type { VoicePreferenceState } from '#/features/voice/voice-preference-store'
import type { VoiceGateStageOptions } from '#/features/voice/voice-gate-stage'

export function resolveVoiceGateStageOptions(
  prefs: Pick<
    VoicePreferenceState,
    'voiceGateEnabled' | 'voiceGateThresholdDb' | 'voiceGateAutoThreshold'
  >,
): VoiceGateStageOptions {
  if (!prefs.voiceGateEnabled) {
    return {
      enabled: false,
      manualThresholdDb: prefs.voiceGateThresholdDb,
    }
  }

  if (prefs.voiceGateAutoThreshold) {
    return { enabled: true, autoDynamic: true }
  }

  return { enabled: true, manualThresholdDb: prefs.voiceGateThresholdDb }
}

export function effectiveVoiceGateStageOptions(
  configured: VoiceGateStageOptions | undefined,
  gateAutoThreshold: boolean,
  manualThresholdDb: number,
): VoiceGateStageOptions {
  if (configured) {
    return configured
  }

  if (gateAutoThreshold) {
    return { autoDynamic: true }
  }

  return { manualThresholdDb }
}
