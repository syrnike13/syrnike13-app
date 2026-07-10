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
  applyNativeMicrophonePipeline,
} from './native-microphone-pipeline-config'

export type NativeMicrophoneSession = {
  sessionId: string
  channelId?: string | null
  nativeParticipantIdentity: string
  setMuted: (muted: boolean) => Promise<void>
  reconnect: (
    livekit: NativeMicrophoneLiveKitCredentials,
    requestId: string,
    muted: boolean,
    audioBitrateKbps: number,
  ) => Promise<void>
  disconnect: () => void
}

export type NativeMicrophoneStoppedHandler = (sessionId: string) => void
export type NativeMicrophoneLiveKitCredentials = {
  url: string
  token: string
  participantIdentity: string
}

export type NativeMicrophoneRecoveryState = {
  voiceConnected: boolean
  wantsMic: boolean
  deafened: boolean
  selfMonitoringActive: boolean
}

type NativeMicrophonePreferences = Pick<
  VoicePreferenceState,
  | 'noiseSuppression'
  | 'echoCancellation'
  | 'inputVolume'
  | 'voiceGateEnabled'
  | 'voiceGateThresholdDb'
  | 'voiceGateAutoThreshold'
>

type NativeMicrophonePipelinePreferences = NativeMicrophonePreferences &
  Pick<VoicePreferenceState, 'preferredAudioInputDevice'>

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

export function nativeMicrophoneSessionOptions(
  livekit: NativeMicrophoneLiveKitCredentials,
  requestId: string,
  muted = false,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
) {
  return {
    kind: 'microphone' as const,
    requestId,
    audioBitrate: clampVoiceChannelAudioBitrateKbps(audioBitrateKbps) * 1000,
    muted,
    livekit,
  }
}

export function nativeMicrophonePipelineConfig(
  prefs: NativeMicrophonePreferences,
  deviceId?: string,
) {
  return {
    deviceId: deviceId ?? null,
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    inputVolume: prefs.inputVolume,
    voiceGateEnabled: prefs.voiceGateEnabled,
    voiceGateThresholdDb: prefs.voiceGateThresholdDb,
    voiceGateAutoThreshold: prefs.voiceGateAutoThreshold,
  }
}

export async function startNativeMicrophonePublisher(
  prefs: NativeMicrophonePipelinePreferences,
  livekit: NativeMicrophoneLiveKitCredentials,
  requestId: string,
  muted = false,
  audioBitrateKbps = DEFAULT_VOICE_CHANNEL_AUDIO_BITRATE_KBPS,
) {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  await applyNativeMicrophonePipeline(
    nativeMicrophonePipelineConfig(prefs, prefs.preferredAudioInputDevice),
  )
  const session = await desktop.media.startSession(
    nativeMicrophoneSessionOptions(
      livekit,
      requestId,
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
  onStopped: NativeMicrophoneStoppedHandler | undefined,
  livekit: NativeMicrophoneLiveKitCredentials,
  requestId: string,
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
    requestId,
    muted,
    audioBitrateKbps,
  )
  let nativeParticipantIdentity = session.nativeParticipantIdentity

  let stopped = false
  let subscriptions: (() => void)[] = []

  const cleanup = () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
  }

  const completeStopped = (stopNativeSession: boolean) => {
    if (stopped) return
    stopped = true
    cleanup()
    if (stopNativeSession) {
      void desktop.media.stopSession(session.sessionId)
    }
    onStopped?.(session.sessionId)
  }

  subscriptions = [
    desktop.media.onStreamEnded?.((sessionId) => {
      if (sessionId !== session.sessionId) return
      completeStopped(false)
    }),
    desktop.media.onStreamError?.((event) => {
      if (event.sessionId !== session.sessionId) return
      completeStopped(false)
    }),
    desktop.media.onRuntimeLost?.((event) => {
      if (event.sessionId !== session.sessionId) return
      if (event.recovering) return
      completeStopped(false)
    }),
  ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe))

  const disconnect = () => completeStopped(true)
  const reconnect = async (
    livekit: NativeMicrophoneLiveKitCredentials,
    requestId: string,
    muted: boolean,
    audioBitrateKbps: number,
  ) => {
    const nextPrefs = readVoicePreferences()
    await applyNativeMicrophonePipeline(
      nativeMicrophonePipelineConfig(
        nextPrefs,
        nextPrefs.preferredAudioInputDevice,
      ),
    )
    const nextSession = await desktop.media.reconnectMicrophoneSession(
      session.sessionId,
      nativeMicrophoneSessionOptions(
        livekit,
        requestId,
        muted,
        audioBitrateKbps,
      ),
    )
    if (nextSession.kind !== 'microphone') {
      throw new Error('Native media engine returned a non-microphone session')
    }
    nativeParticipantIdentity = nextSession.nativeParticipantIdentity
  }

  return {
    sessionId: session.sessionId,
    get nativeParticipantIdentity() {
      return nativeParticipantIdentity
    },
    setMuted: (muted) => desktop.media.setMicrophoneMuted(session.sessionId, muted),
    reconnect,
    disconnect,
  }
}
