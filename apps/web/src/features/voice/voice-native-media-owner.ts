import type { Room } from 'livekit-client'

import type {
  LiveKitNativeCredentials,
  LiveKitNativeMediaKind,
  LiveKitNativePublisherCredentials,
} from '#/features/voice/voice-join'
import type { NativeMicrophoneSession } from '#/features/voice/native-microphone-publish'
import {
  disconnectNativeMediaForHandoff,
  refreshNativeLiveKitCredentials,
  resetNativeMediaState,
  setNativeMicrophoneMuted,
  startNativeMicrophone,
  type DisconnectNativeMediaForHandoffDeps,
  type RefreshNativeLiveKitCredentialsDeps,
  type ResetNativeMediaStateDeps,
  type SetNativeMicrophoneMutedDeps,
  type StartNativeMicrophoneDeps,
} from '#/features/voice/voice-native-media'

type WithoutNativeMicrophoneRefs<T> = Omit<
  T,
  | 'nativeMicrophoneRef'
  | 'nativeMicrophoneStartRef'
  | 'nativeMicrophoneStartGenerationRef'
  | 'nativeMicrophoneMutedRef'
>

export type VoiceNativeMediaOwner = {
  setLiveKitCredentials(credentials: LiveKitNativeCredentials): void
  refreshLiveKitCredentials<TRawCredentials>(
    deps: Omit<
      RefreshNativeLiveKitCredentialsDeps<TRawCredentials>,
      'liveKitCredentialsRef'
    >,
    mediaKind: LiveKitNativeMediaKind,
    force?: boolean,
  ): Promise<LiveKitNativePublisherCredentials>
  reset(deps: WithoutNativeMicrophoneRefs<ResetNativeMediaStateDeps>): void
  disconnectForHandoff(
    deps: WithoutNativeMicrophoneRefs<DisconnectNativeMediaForHandoffDeps>,
  ): void
  setMicrophoneMuted(
    deps: WithoutNativeMicrophoneRefs<SetNativeMicrophoneMutedDeps>,
    muted: boolean,
  ): Promise<void>
  startMicrophone(
    deps: Omit<
      StartNativeMicrophoneDeps<Room, NativeMicrophoneSession>,
      | 'nativeMicrophoneRef'
      | 'nativeMicrophoneStartRef'
      | 'nativeMicrophoneStartGenerationRef'
      | 'nativeMicrophoneMutedRef'
      | 'setNativeMicrophoneMuted'
      | 'setNativeMicrophoneSession'
    >,
  ): Promise<boolean>
  handleMicrophoneStopped(sessionId: string): boolean
  getMicrophoneSession(): NativeMicrophoneSession | null
  hasActiveMicrophone(): boolean
  isMicrophoneMuted(): boolean
  hasMicrophonePublishing(): boolean
}

export function createVoiceNativeMediaOwner(): VoiceNativeMediaOwner {
  const nativeMicrophoneRef = { current: null as NativeMicrophoneSession | null }
  const nativeMicrophoneStartRef = {
    current: null as Promise<boolean> | null,
  }
  const nativeMicrophoneStartGenerationRef = { current: 0 }
  const nativeMicrophoneMutedRef = { current: false }
  const liveKitCredentialsRef = {
    current: null as LiveKitNativeCredentials | null,
  }

  return {
    setLiveKitCredentials(credentials) {
      liveKitCredentialsRef.current = credentials
    },

    refreshLiveKitCredentials(deps, mediaKind, force = false) {
      return refreshNativeLiveKitCredentials(
        {
          ...deps,
          liveKitCredentialsRef,
        },
        mediaKind,
        force,
      )
    },

    reset(deps) {
      resetNativeMediaState({
        ...deps,
        nativeMicrophoneRef,
        nativeMicrophoneStartRef,
        nativeMicrophoneStartGenerationRef,
        nativeMicrophoneMutedRef,
      })
    },

    disconnectForHandoff(deps) {
      disconnectNativeMediaForHandoff({
        ...deps,
        nativeMicrophoneRef,
        nativeMicrophoneStartRef,
        nativeMicrophoneStartGenerationRef,
        nativeMicrophoneMutedRef,
      })
    },

    setMicrophoneMuted(deps, muted) {
      return setNativeMicrophoneMuted(
        {
          ...deps,
          nativeMicrophoneRef,
          nativeMicrophoneMutedRef,
        },
        muted,
      )
    },

    startMicrophone(deps) {
      return startNativeMicrophone({
        ...deps,
        nativeMicrophoneRef,
        nativeMicrophoneStartRef,
        nativeMicrophoneStartGenerationRef,
        nativeMicrophoneMutedRef,
        setNativeMicrophoneMuted: (muted) =>
          setNativeMicrophoneMuted(
            {
              nativeMicrophoneRef,
              nativeMicrophoneMutedRef,
              setMicPublishing: deps.setMicPublishing,
              setSelfSpeaking: deps.setSelfSpeaking,
              syncRoomParticipants: deps.syncRoomParticipants,
            },
            muted,
          ),
        setNativeMicrophoneSession: (session) => {
          nativeMicrophoneRef.current = session
        },
      })
    },

    handleMicrophoneStopped(sessionId) {
      if (nativeMicrophoneRef.current?.sessionId !== sessionId) return false
      nativeMicrophoneRef.current = null
      nativeMicrophoneMutedRef.current = false
      return true
    },

    getMicrophoneSession() {
      return nativeMicrophoneRef.current
    },

    hasActiveMicrophone() {
      return Boolean(nativeMicrophoneRef.current)
    },

    isMicrophoneMuted() {
      return nativeMicrophoneMutedRef.current
    },

    hasMicrophonePublishing() {
      return Boolean(nativeMicrophoneRef.current && !nativeMicrophoneMutedRef.current)
    },
  }
}
