import type { LocalParticipant } from 'livekit-client'

import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  clearNativeMicrophoneRuntimeConfig,
  configureNativeMicrophoneRuntime,
} from './native-microphone-runtime-config'

export type NativeMicrophoneSession = {
  sessionId: string
  nativeParticipantIdentity: string
  stop: () => void
}

export type NativeMicrophoneStoppedHandler = (sessionId: string) => void
export type NativeMicrophoneLiveKitCredentials = {
  url: string
  token: string
  participantIdentity: string
}

export function shouldUseNativeMicrophone() {
  return getSyrnikeDesktop()?.platform.os === 'win32'
}

export function nativeMicrophoneSessionOptions(
  prefs: VoicePreferenceState,
  livekit: NativeMicrophoneLiveKitCredentials,
  deviceId = prefs.preferredAudioInputDevice,
) {
  return {
    kind: 'microphone' as const,
    deviceId,
    sampleRate: 48_000 as const,
    channels: 1 as const,
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
    livekit,
  }
}

export async function startNativeMicrophonePublisher(
  prefs: VoicePreferenceState,
  livekit: NativeMicrophoneLiveKitCredentials,
  deviceId?: string,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const session = await desktop.media.startSession(
    nativeMicrophoneSessionOptions(prefs, livekit, deviceId),
  )

  if (session.kind !== 'microphone') {
    throw new Error('Native media engine returned a non-microphone session')
  }

  return { desktop, session }
}

export async function publishNativeMicrophone(
  _participant: LocalParticipant,
  onStopped?: NativeMicrophoneStoppedHandler,
  livekit?: NativeMicrophoneLiveKitCredentials,
): Promise<NativeMicrophoneSession> {
  if (!livekit) {
    throw new Error('LiveKit credentials are required for native microphone publishing')
  }
  const prefs = readVoicePreferences()
  const { desktop, session } = await startNativeMicrophonePublisher(
    prefs,
    livekit,
  )

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearNativeMicrophoneRuntimeConfig(session.sessionId)
    void desktop.media.stopSession(session.sessionId)
    onStopped?.(session.sessionId)
  }

  return {
    sessionId: session.sessionId,
    nativeParticipantIdentity: session.nativeParticipantIdentity,
    stop,
  }
}

export function configureNativeMicrophoneSession(
  session: NativeMicrophoneSession | null,
  prefs: VoicePreferenceState,
) {
  configureNativeMicrophoneRuntime(session?.sessionId, {
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
  })
}
