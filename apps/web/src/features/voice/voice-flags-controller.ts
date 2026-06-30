import { useCallback } from 'react'
import type { Room } from 'livekit-client'

import { playUiSound } from '#/features/sounds/sound-player'
import {
  shouldUseNativeMicrophone,
} from '#/features/voice/native-microphone-publish'
import type { VoiceNativeMediaOwner } from '#/features/voice/voice-native-media-owner'
import { participantMicPublishing } from '#/features/voice/voice-participant-media'
import {
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
} from '#/features/voice/voice-participant-sync'
import { voiceMicPublishOptions } from '#/features/voice/voice-capture'
import { applyMicProcessing } from '#/features/voice/voice-mic-processing'
import {
  describeMicDeviceError,
  type VoiceMicIssue,
  type VoiceStatus,
} from '#/features/voice/voice-mic-status'
import { voicePreferenceStore } from '#/features/voice/voice-preference-store'
import type { MutableRef } from '#/features/voice/voice-types'

export type SelfMonitoringState = {
  active: boolean
  restorePublishing: boolean
  sequence: number
}

export type VoiceFlagsControllerOptions = {
  authUserId: string | null
  status: VoiceStatus
  roomRef: MutableRef<Room | null>
  channelIdRef: MutableRef<string | null>
  deafenedRef: MutableRef<boolean>
  selfMonitoringRef: MutableRef<SelfMonitoringState>
  nativeMedia: VoiceNativeMediaOwner
  activeChannelAudioBitrateKbps: () => number
  applyRemoteAudio: (deafened?: boolean) => void
  isCurrentVoiceSession: (
    room: Room,
    targetChannelId: string | null,
  ) => boolean
  readCurrentVoiceFlags: (
    room?: Room | null,
  ) => { selfMute: boolean; selfDeaf: boolean }
  setCurrentMicIssue: (issue: VoiceMicIssue | null, notify?: boolean) => void
  setDeafened: (deafened: boolean) => void
  setMicEnabled: (enabled: boolean) => void
  setMicPublishing: (publishing: boolean) => void
  setNativeMicrophoneMuted: (muted: boolean) => Promise<void>
  setSelfSpeaking: (speaking: boolean) => void
  startNativeMicrophone: (room: Room, muted?: boolean) => Promise<boolean>
  syncLocalSpeakingTrack: (room?: Room | null) => void
  syncMicFromRoom: (room: Room, issue?: VoiceMicIssue | null) => void
  syncRoomParticipants: () => void
  syncVoiceFlagsToGateway: (
    channelId: string,
    selfMute: boolean,
    selfDeaf: boolean,
  ) => void
}

export function useVoiceFlagsController({
  authUserId,
  status,
  roomRef,
  channelIdRef,
  deafenedRef,
  selfMonitoringRef,
  nativeMedia,
  activeChannelAudioBitrateKbps,
  applyRemoteAudio,
  isCurrentVoiceSession,
  readCurrentVoiceFlags,
  setCurrentMicIssue,
  setDeafened,
  setMicEnabled,
  setMicPublishing,
  setNativeMicrophoneMuted,
  setSelfSpeaking,
  startNativeMicrophone,
  syncLocalSpeakingTrack,
  syncMicFromRoom,
  syncRoomParticipants,
  syncVoiceFlagsToGateway,
}: VoiceFlagsControllerOptions) {
  const setSelfMonitoringActive = useCallback(
    (active: boolean) => {
      const room = roomRef.current
      const activeChannelId = channelIdRef.current
      const userId = authUserId
      if (selfMonitoringRef.current.active === active) return
      const sequence = selfMonitoringRef.current.sequence + 1
      selfMonitoringRef.current.sequence = sequence
      selfMonitoringRef.current.active = active

      if (!room || !activeChannelId) {
        if (!active) {
          selfMonitoringRef.current.restorePublishing = false
        }
        return
      }

      const wantsMic = voicePreferenceStore.getMicEnabled()
      const publishing = shouldUseNativeMicrophone()
        ? nativeMedia.hasMicrophonePublishing()
        : participantMicPublishing(room.localParticipant)

      if (active) {
        selfMonitoringRef.current.restorePublishing = wantsMic
        if (publishing) {
          if (shouldUseNativeMicrophone()) {
            void setNativeMicrophoneMuted(true).catch(() => {})
          } else {
            void room.localParticipant.setMicrophoneEnabled(false)
          }
        }
        setMicPublishing(false)
        setSelfSpeaking(false)
        setCurrentMicIssue(null)
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
        }
        syncRoomParticipants()
        return
      }

      const shouldRestorePublishing =
        selfMonitoringRef.current.restorePublishing &&
        wantsMic &&
        !deafenedRef.current
      selfMonitoringRef.current.restorePublishing = false

      if (!shouldRestorePublishing) {
        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, true).catch(() => {})
        }
        setMicPublishing(false)
        setSelfSpeaking(false)
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
        }
        syncRoomParticipants()
        return
      }

      if (shouldUseNativeMicrophone()) {
        void startNativeMicrophone(room, false)
          .then((started) => {
            if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            if (
              selfMonitoringRef.current.active ||
              selfMonitoringRef.current.sequence !== sequence
            ) {
              void setNativeMicrophoneMuted(true).catch(() => {})
              return
            }
            setCurrentMicIssue(null)
            syncMicFromRoom(room)
            syncLocalSpeakingTrack(room)
            syncRoomParticipants()
            if (status === 'connected') {
              syncVoiceFlagsToGateway(
                activeChannelId,
                false,
                deafenedRef.current,
              )
            }
          })
          .catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        return
      }

      void room.localParticipant
        .setMicrophoneEnabled(
          true,
          undefined,
          voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
        )
        .then(() => {
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          if (
            selfMonitoringRef.current.active ||
            selfMonitoringRef.current.sequence !== sequence
          ) {
            void room.localParticipant.setMicrophoneEnabled(false)
            return
          }
          void applyMicProcessing(room.localParticipant)
            .then(() => {
              syncLocalSpeakingTrack(room)
            })
            .catch(() => {
              // applyMicProcessing не критичен; говорящая-детекция останется
              // на необработанном треке.
            })
          setCurrentMicIssue(null)
          syncMicFromRoom(room)
          syncRoomParticipants()
          if (status === 'connected') {
            syncVoiceFlagsToGateway(
              activeChannelId,
              !participantMicPublishing(room.localParticipant),
              deafenedRef.current,
            )
          }
        })
        .catch((error) => {
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
        })
    },
    [
      activeChannelAudioBitrateKbps,
      authUserId,
      channelIdRef,
      deafenedRef,
      isCurrentVoiceSession,
      nativeMedia,
      roomRef,
      selfMonitoringRef,
      setCurrentMicIssue,
      setMicPublishing,
      setNativeMicrophoneMuted,
      setSelfSpeaking,
      startNativeMicrophone,
      status,
      syncLocalSpeakingTrack,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const toggleMic = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = authUserId
    const nextMic = !voicePreferenceStore.getMicEnabled()
    voicePreferenceStore.setMicEnabled(nextMic)
    playUiSound(nextMic ? 'voice.unmute' : 'voice.mute')
    setMicEnabled(nextMic)
    if (!nextMic) {
      setCurrentMicIssue(null)
    }

    const wasDeafened = deafenedRef.current
    if (nextMic && wasDeafened) {
      voicePreferenceStore.setDeafened(false)
      setDeafened(false)
      deafenedRef.current = false
      applyRemoteAudio(false)
      if (activeChannelId && userId) {
        patchLocalVoiceDeafen(activeChannelId, userId, false)
      }
    }

    if (room) {
      if (shouldUseNativeMicrophone()) {
        if (nextMic) {
          if (selfMonitoringRef.current.active) {
            selfMonitoringRef.current.restorePublishing = true
            void startNativeMicrophone(room, true).catch((error) => {
              if (!isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
            })
            setMicPublishing(false)
            setSelfSpeaking(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
              if (status === 'connected') {
                syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
              }
            }
            syncRoomParticipants()
            return
          }
          void startNativeMicrophone(room, false)
            .then((started) => {
              if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room)
              syncRoomParticipants()
              if (activeChannelId && userId && status === 'connected') {
                const { selfMute, selfDeaf } = readCurrentVoiceFlags(room)
                syncVoiceFlagsToGateway(activeChannelId, selfMute, selfDeaf)
              }
            })
            .catch((error) => {
              if (!isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
              if (activeChannelId && userId && status === 'connected') {
                syncVoiceFlagsToGateway(
                  activeChannelId,
                  true,
                  deafenedRef.current,
                )
              }
            })
        } else {
          selfMonitoringRef.current.restorePublishing = false
          void startNativeMicrophone(room, true).catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
          setSelfSpeaking(false)
          syncMicFromRoom(room)
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
          }
        }
        return
      }
      if (!nextMic) {
        selfMonitoringRef.current.restorePublishing = false
        setSelfSpeaking(false)
      }
      void room.localParticipant
        .setMicrophoneEnabled(
          nextMic && !selfMonitoringRef.current.active,
          undefined,
          voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
        )
        .then(() => {
          // Recency-check после await: сессия могла смениться во время операции.
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          if (nextMic && selfMonitoringRef.current.active) {
            selfMonitoringRef.current.restorePublishing = true
            setMicPublishing(false)
            setSelfSpeaking(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
            }
          } else {
            if (nextMic) {
              void applyMicProcessing(room.localParticipant)
                .then(() => {
                  if (!isCurrentVoiceSession(room, activeChannelId)) return
                  syncLocalSpeakingTrack(room)
                })
                .catch(() => {
                  // applyMicProcessing не критичен; говорящая-детекция просто
                  // останется на необработанном треке.
                })
            } else {
              syncLocalSpeakingTrack(room)
            }
            syncMicFromRoom(room)
          }
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            const selfMute =
              nextMic && selfMonitoringRef.current.active
                ? true
                : !participantMicPublishing(room.localParticipant)
            syncVoiceFlagsToGateway(activeChannelId, selfMute, deafenedRef.current)
          }
        })
        .catch((error) => {
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
          }
        })
      return
    }

    setMicPublishing(nextMic)
    if (activeChannelId && userId) {
      patchLocalVoiceMic(activeChannelId, userId, nextMic)
      if (status === 'connected') {
        syncVoiceFlagsToGateway(
          activeChannelId,
          !nextMic,
          deafenedRef.current,
        )
      }
    }
  }, [
    activeChannelAudioBitrateKbps,
    applyRemoteAudio,
    authUserId,
    channelIdRef,
    deafenedRef,
    isCurrentVoiceSession,
    readCurrentVoiceFlags,
    roomRef,
    selfMonitoringRef,
    setCurrentMicIssue,
    setDeafened,
    setMicEnabled,
    setMicPublishing,
    setSelfSpeaking,
    startNativeMicrophone,
    status,
    syncLocalSpeakingTrack,
    syncMicFromRoom,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = authUserId
    const nextDeafened = !voicePreferenceStore.getDeafened()
    voicePreferenceStore.setDeafened(nextDeafened)
    playUiSound(nextDeafened ? 'voice.deafen' : 'voice.undeafen')
    setDeafened(nextDeafened)
    deafenedRef.current = nextDeafened
    applyRemoteAudio(nextDeafened)

    if (nextDeafened) {
      voicePreferenceStore.setMicEnabled(false)
      setMicEnabled(false)
      setMicPublishing(false)
      setSelfSpeaking(false)
      setCurrentMicIssue(null)
      if (room) {
        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, true).catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        } else {
          void room.localParticipant.setMicrophoneEnabled(false)
          syncLocalSpeakingTrack(room)
        }
      }
      if (activeChannelId && userId) {
        patchLocalVoiceMic(activeChannelId, userId, false)
      }
    }

    if (activeChannelId && userId) {
      patchLocalVoiceDeafen(activeChannelId, userId, nextDeafened)
      if (status === 'connected') {
        syncVoiceFlagsToGateway(
          activeChannelId,
          nextDeafened || !voicePreferenceStore.getMicEnabled(),
          nextDeafened,
        )
      }
    }
    if (room && activeChannelId) {
      syncLocalSpeakingTrack(room)
      syncRoomParticipants()
    }
  }, [
    applyRemoteAudio,
    authUserId,
    channelIdRef,
    deafenedRef,
    isCurrentVoiceSession,
    roomRef,
    setCurrentMicIssue,
    setDeafened,
    setMicEnabled,
    setMicPublishing,
    setSelfSpeaking,
    startNativeMicrophone,
    status,
    syncLocalSpeakingTrack,
    syncMicFromRoom,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  return {
    setSelfMonitoringActive,
    toggleMic,
    toggleDeafen,
  }
}
