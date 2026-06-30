import { useCallback, useRef, useState } from 'react'
import type { Room } from 'livekit-client'
import { toast } from 'sonner'

import {
  isNativeScreenPublished,
  isNativeScreenStarting,
  type NativeMediaState,
} from '#/features/voice/native-media-coordinator'
import { localParticipantVoiceFlags } from '#/features/voice/voice-participant-media'
import { patchLocalVoiceCamera } from '#/features/voice/voice-participant-sync'
import {
  syncRoomParticipants as syncRoomParticipantsForRoom,
} from '#/features/voice/voice-stage-media-sync'
import { playUiSound } from '#/features/sounds/sound-player'
import type { MutableRef } from '#/features/voice/voice-types'

export type VoiceMediaFlagsOptions = {
  authUserId: string | null
  roomRef: MutableRef<Room | null>
  channelIdRef: MutableRef<string | null>
  nativeMediaState: NativeMediaState
  nativeMediaStateRef: MutableRef<NativeMediaState>
  syncStageMediaItems: (room: Room) => void
}

export function useVoiceMediaFlags({
  authUserId,
  roomRef,
  channelIdRef,
  nativeMediaState,
  nativeMediaStateRef,
  syncStageMediaItems,
}: VoiceMediaFlagsOptions) {
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [screenShareEnabled, setScreenShareEnabled] = useState(false)
  const [screenShareStarting, setScreenShareStartingState] = useState(false)
  const screenShareStartingRef = useRef(false)

  const setScreenShareStarting = useCallback((starting: boolean) => {
    screenShareStartingRef.current = starting
    setScreenShareStartingState(starting)
  }, [])

  const syncRoomParticipants = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    syncRoomParticipantsForRoom({
      room,
      nativeMediaState: nativeMediaStateRef.current,
      activeChannelId: channelIdRef.current,
      userId: authUserId,
      setCameraEnabled,
      setScreenShareEnabled,
      patchLocalVoiceCamera,
      syncStageMediaItems,
    })
  }, [
    authUserId,
    channelIdRef,
    nativeMediaStateRef,
    roomRef,
    syncStageMediaItems,
  ])

  const toggleCamera = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    const next = !localParticipantVoiceFlags(room.localParticipant).camera
    void room.localParticipant
      .setCameraEnabled(next)
      .then(() => {
        setCameraEnabled(next)
        playUiSound(next ? 'camera.started' : 'camera.stopped')
        syncRoomParticipants()
      })
      .catch((error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось переключить камеру',
        )
      })
  }, [roomRef, syncRoomParticipants])

  return {
    cameraEnabled,
    screenShareEnabled,
    screenShareStarting,
    screenShareEnabledForUi:
      screenShareEnabled || isNativeScreenPublished(nativeMediaState),
    screenShareStartingForUi:
      screenShareStarting || isNativeScreenStarting(nativeMediaState),
    setCameraEnabled,
    setScreenShareEnabled,
    setScreenShareStarting,
    screenShareStartingRef,
    syncRoomParticipants,
    toggleCamera,
  }
}
