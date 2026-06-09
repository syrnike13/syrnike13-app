import type { LocalParticipant } from 'livekit-client'

import {
  readVoicePreferences,
  type VoicePreferenceState,
} from '#/features/voice/voice-preference-store'
import {
  clampVoiceChannelAudioBitrateKbps,
  DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
} from '#/lib/channel-audio-bitrate'
import { getSyrnikeDesktop } from '#/platform/runtime'

import {
  clearNativeMicrophoneRuntimeConfig,
  configureNativeMicrophoneRuntime,
} from './native-microphone-runtime-config'

export type NativeMicrophoneSession = {
  sessionId: string
  nativeParticipantIdentity: string
  setMuted: (muted: boolean) => Promise<void>
  disconnect: () => void
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
  muted = false,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
) {
  return {
    kind: 'microphone' as const,
    deviceId,
    sampleRate: 48_000 as const,
    channels: 1 as const,
    audioBitrate: clampVoiceChannelAudioBitrateKbps(audioBitrateKbps) * 1000,
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: false,
    muted,
    livekit,
  }
}

export async function startNativeMicrophonePublisher(
  prefs: VoicePreferenceState,
  livekit: NativeMicrophoneLiveKitCredentials,
  deviceId?: string,
  muted = false,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const session = await desktop.media.startSession(
    nativeMicrophoneSessionOptions(
      prefs,
      livekit,
      deviceId,
      muted,
      audioBitrateKbps,
    ),
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
  muted = false,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
): Promise<NativeMicrophoneSession> {
  if (!livekit) {
    throw new Error('LiveKit credentials are required for native microphone publishing')
  }
  const prefs = readVoicePreferences()
  const { desktop, session } = await startNativeMicrophonePublisher(
    prefs,
    livekit,
    undefined,
    muted,
    audioBitrateKbps,
  )

  let stopped = false
  const disconnect = () => {
    if (stopped) return
    stopped = true
    clearNativeMicrophoneRuntimeConfig(session.sessionId)
    void desktop.media.stopSession(session.sessionId)
    onStopped?.(session.sessionId)
  }

  return {
    sessionId: session.sessionId,
    nativeParticipantIdentity: session.nativeParticipantIdentity,
    setMuted: (muted) => desktop.media.setMicrophoneMuted(session.sessionId, muted),
    disconnect,
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
    voiceGateAutoThreshold: false,
  })
}
