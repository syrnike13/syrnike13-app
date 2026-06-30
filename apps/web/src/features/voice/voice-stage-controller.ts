import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { RemoteParticipant, Room } from 'livekit-client'
import { toast } from 'sonner'

import { isVoiceLocalUserId } from '#/features/voice/voice-connecting-preview'
import type { NativeMediaState } from '#/features/voice/native-media-coordinator'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import type { NativeScreenShareSession } from '#/features/voice/native-screen-share-publish'
import type {
  NativeScreenPublicationLoss,
} from '#/features/voice/native-screen-publication-loss'
import {
  SCREEN_VIEWER_SOUND_TOPIC,
  createScreenViewerSoundPayload,
} from '#/features/voice/voice-screen-viewer-sounds'
import {
  readStageMediaFilters,
  writeStageMediaFilters,
} from '#/features/voice/voice-stage-filters'
import {
  type StageMediaFilters,
  stageMediaItemId,
} from '#/features/voice/voice-stage-media'
import {
  applyRemoteScreenParticipantSubscription as applyRemoteScreenParticipantSubscriptionToRoom,
  syncStageMediaItems as syncStageMediaItemsForRoom,
} from '#/features/voice/voice-stage-media-sync'
import {
  resolveStageScreenSubscriptionTarget,
  setRemoteScreenWatchIntent,
  setStageScreenSubscription,
  stageScreenMediaUserId,
} from '#/features/voice/voice-stage-subscription'
import { isVoiceConnectedInChannel } from '#/features/voice/voice-watch-screen-share'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'
import type { VoiceDebugAgentPayload } from '#/features/voice/voice-debug-agent-log'
import type { MutableRef } from '#/features/voice/voice-types'

export type VoiceStageControllerOptions = {
  authUserId: string | null
  channelId: string | null
  status: VoiceStatus
  join: (channelId: string) => Promise<boolean>
  roomRef: MutableRef<Room | null>
  nativeMediaStateRef: MutableRef<NativeMediaState>
  stoppedNativeScreenIdentityRef: MutableRef<string | null>
  nativeScreenShareRef: MutableRef<NativeScreenShareSession | null>
  stopNativeScreenShare: () => Promise<void>
  setScreenShareEnabled: (enabled: boolean) => void
  syncRoomParticipants: () => void
  onNativeScreenPublicationLost: (loss: NativeScreenPublicationLoss) => void
  logStageSyncDebug: (event: VoiceDebugAgentPayload) => void
}

export function useVoiceStageController({
  authUserId,
  channelId,
  status,
  join,
  roomRef,
  nativeMediaStateRef,
  stoppedNativeScreenIdentityRef,
  nativeScreenShareRef,
  stopNativeScreenShare,
  setScreenShareEnabled,
  syncRoomParticipants,
  onNativeScreenPublicationLost,
  logStageSyncDebug,
}: VoiceStageControllerOptions) {
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const watchedRemoteScreenIdsRef = useRef<Set<string>>(new Set())
  const pendingScreenWatchIdsRef = useRef<Set<string>>(new Set())
  const lastStageSyncDebugKeyRef = useRef<string | null>(null)
  const [stageMediaItems, setStageMediaItemsState] = useState<
    VoiceStageMediaItem[]
  >([])
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [focusedMediaId, setFocusedMediaId] = useState<string | null>(null)
  const [stageFocusNonce, setStageFocusNonce] = useState(0)
  const [stageFullscreen, setStageFullscreen] = useState(false)

  const setStageMediaItems = useCallback((items: VoiceStageMediaItem[]) => {
    if (areStageMediaItemsEqual(stageMediaItemsRef.current, items)) return
    stageMediaItemsRef.current = items
    setStageMediaItemsState(items)
  }, [])

  const publishScreenViewerSound = useCallback(
    (room: Room, screenOwnerId: string, action: 'join' | 'leave') => {
      return room.localParticipant
        .publishData(createScreenViewerSoundPayload({ action, screenOwnerId }), {
          reliable: true,
          destinationIdentities: [screenOwnerId],
          topic: SCREEN_VIEWER_SOUND_TOPIC,
        })
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn('Failed to publish screen viewer sound intent', error)
          }
        })
    },
    [],
  )

  const publishScreenViewerLeaves = useCallback(
    async (room: Room) => {
      await Promise.all(
        Array.from(watchedRemoteScreenIdsRef.current).flatMap((mediaId) => {
          const screenOwnerId = stageScreenMediaUserId(mediaId)
          return screenOwnerId
            ? [publishScreenViewerSound(room, screenOwnerId, 'leave')]
            : []
        }),
      )
    },
    [publishScreenViewerSound],
  )

  const setStageMediaFilters: Dispatch<
    SetStateAction<StageMediaFilters>
  > = useCallback((next) => {
    setStageMediaFiltersState((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      writeStageMediaFilters(value)
      return value
    })
  }, [])

  const applyRemoteScreenParticipantSubscription = useCallback(
    (participant: RemoteParticipant, subscribed?: boolean) => {
      return applyRemoteScreenParticipantSubscriptionToRoom(participant, {
        subscribed,
        currentUserId: authUserId,
        localParticipantIdentity: roomRef.current?.localParticipant.identity ?? null,
        watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
        pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
      })
    },
    [authUserId, roomRef],
  )

  const syncStageMediaItems = useCallback(
    (room: Room) => {
      syncStageMediaItemsForRoom({
        room,
        nativeMediaState: nativeMediaStateRef.current,
        stoppedNativeScreenIdentity: stoppedNativeScreenIdentityRef.current,
        authUserId,
        stageMediaFilters,
        watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
        pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
        lastStageSyncDebugKey: lastStageSyncDebugKeyRef,
        applyRemoteScreenParticipantSubscription,
        setStageMediaItems,
        onNativeScreenPublicationLost,
        logStageSyncDebug,
      })
    },
    [
      applyRemoteScreenParticipantSubscription,
      authUserId,
      logStageSyncDebug,
      nativeMediaStateRef,
      onNativeScreenPublicationLost,
      setStageMediaItems,
      stageMediaFilters,
      stoppedNativeScreenIdentityRef,
    ],
  )

  const requestStageMediaFocus = useCallback((mediaId: string) => {
    setFocusedMediaId(mediaId)
    setStageFocusNonce((current) => current + 1)
  }, [])

  const watchParticipantScreenShare = useCallback(
    async (targetChannelId: string, userId: string) => {
      const mediaId = stageMediaItemId(userId, 'screen')
      const isLocal = isVoiceLocalUserId(userId, authUserId)
      const wasWatching = watchedRemoteScreenIdsRef.current.has(mediaId)

      if (!isLocal) {
        pendingScreenWatchIdsRef.current.add(mediaId)
        watchedRemoteScreenIdsRef.current.add(mediaId)
      }

      if (!isVoiceConnectedInChannel({ channelId, status }, targetChannelId)) {
        // join может reject'нуть (нет сессии, таймаут, отменён). Не позволяем
        // этому всплыть unhandled rejection и не продолжаем с roomRef, который
        // мог не подключиться.
        let joined = false
        try {
          joined = await join(targetChannelId)
        } catch (error) {
          console.warn('[voice-stage] failed to join for screen watch', error)
        }
        if (!joined) return
      }

      if (!isLocal) {
        pendingScreenWatchIdsRef.current.add(mediaId)
        watchedRemoteScreenIdsRef.current.add(mediaId)
      }

      const room = roomRef.current
      if (room && !isLocal) {
        for (const participant of room.remoteParticipants.values()) {
          if (baseVoiceIdentity(participant.identity) !== userId) continue
          applyRemoteScreenParticipantSubscription(participant, true)
        }
        if (!wasWatching) {
          void publishScreenViewerSound(room, userId, 'join')
        }
        syncStageMediaItems(room)
      }

      requestStageMediaFocus(mediaId)
    },
    [
      applyRemoteScreenParticipantSubscription,
      authUserId,
      channelId,
      join,
      publishScreenViewerSound,
      requestStageMediaFocus,
      roomRef,
      status,
      syncStageMediaItems,
    ],
  )

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const room = roomRef.current
      if (!room) return
      const item = stageMediaItemsRef.current.find(
        (stageItem) => stageItem.id === mediaId,
      )
      const currentUserIds = new Set<string>()
      if (authUserId) currentUserIds.add(authUserId)
      currentUserIds.add(baseVoiceIdentity(room.localParticipant.identity))
      const target = resolveStageScreenSubscriptionTarget(
        item,
        mediaId,
        currentUserIds,
      )
      if (!target) return
      const wasWatching = watchedRemoteScreenIdsRef.current.has(target.mediaId)

      const action = item
        ? setStageScreenSubscription(item, subscribed)
        : target.isLocal && !subscribed
          ? 'stop-local-screen'
          : 'none'

      if (!target.isLocal) {
        if (!target.userId) return
        setRemoteScreenWatchIntent(
          watchedRemoteScreenIdsRef.current,
          pendingScreenWatchIdsRef.current,
          target.mediaId,
          subscribed,
        )
        for (const participant of room.remoteParticipants.values()) {
          if (baseVoiceIdentity(participant.identity) !== target.userId) continue
          applyRemoteScreenParticipantSubscription(participant, subscribed)
        }
        if (wasWatching !== subscribed) {
          void publishScreenViewerSound(
            room,
            target.userId,
            subscribed ? 'join' : 'leave',
          )
        }

        syncStageMediaItems(room)
        return
      }

      if (action === 'stop-local-screen') {
        if (nativeScreenShareRef.current) {
          void stopNativeScreenShare()
            .then(() => {
              setScreenShareEnabled(false)
              syncRoomParticipants()
            })
            .catch((error) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось остановить демонстрацию',
              )
            })
          return
        }

        void room.localParticipant
          .setScreenShareEnabled(false)
          .then(() => {
            setScreenShareEnabled(false)
            syncRoomParticipants()
          })
          .catch((error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось остановить демонстрацию',
            )
          })
        return
      }

      if (action === 'none') {
        syncStageMediaItems(room)
      }
    },
    [
      applyRemoteScreenParticipantSubscription,
      authUserId,
      nativeScreenShareRef,
      publishScreenViewerSound,
      roomRef,
      setScreenShareEnabled,
      stopNativeScreenShare,
      syncRoomParticipants,
      syncStageMediaItems,
    ],
  )

  const resetStageState = useCallback(() => {
    watchedRemoteScreenIdsRef.current.clear()
    pendingScreenWatchIdsRef.current.clear()
    setStageMediaItems([])
    setFocusedMediaId(null)
    setStageFullscreen(false)
  }, [setStageMediaItems])

  const toggleStageFullscreen = useCallback(() => {
    setStageFullscreen((value) => !value)
  }, [])

  useEffect(() => {
    const room = roomRef.current
    if (room) syncStageMediaItems(room)
  }, [roomRef, stageMediaFilters, syncStageMediaItems])

  useEffect(() => {
    setFocusedMediaId((current) =>
      current && stageMediaItems.some((item) => item.id === current && item.live)
        ? current
        : null,
    )
  }, [stageMediaItems])

  return {
    stageMediaItems,
    stageMediaItemsRef,
    stageMediaFilters,
    setStageMediaFilters,
    focusedMediaId,
    stageFocusNonce,
    setFocusedMediaId,
    stageFullscreen,
    toggleStageFullscreen,
    syncStageMediaItems,
    applyRemoteScreenParticipantSubscription,
    watchParticipantScreenShare,
    setStageMediaSubscribed,
    publishScreenViewerLeaves,
    resetStageState,
  }
}

function areStageMediaItemsEqual(
  left: readonly VoiceStageMediaItem[],
  right: readonly VoiceStageMediaItem[],
) {
  if (left.length !== right.length) return false

  return left.every((leftItem, index) => {
    const rightItem = right[index]
    return (
      leftItem.id === rightItem.id &&
      leftItem.userId === rightItem.userId &&
      leftItem.kind === rightItem.kind &&
      leftItem.source === rightItem.source &&
      leftItem.track === rightItem.track &&
      leftItem.publication === rightItem.publication &&
      leftItem.isLocal === rightItem.isLocal &&
      leftItem.subscribed === rightItem.subscribed &&
      leftItem.live === rightItem.live &&
      leftItem.pending === rightItem.pending
    )
  })
}
