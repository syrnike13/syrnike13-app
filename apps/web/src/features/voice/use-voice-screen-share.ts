import { useCallback, useEffect } from 'react'
import type { Room } from 'livekit-client'
import { toast } from 'sonner'

import {
  isLiveKitTokenFailure,
} from '#/features/voice/voice-token-helpers'
import {
  handleNativeScreenPublicationLost as handleNativeScreenPublicationLostFromDeps,
  startLocalScreenShare as startLocalScreenShareFromDeps,
  stopNativeScreenShare as stopNativeScreenShareFromDeps,
  teardownScreenShare,
} from '#/features/voice/voice-screen-share'
import type {
  NativeScreenPublicationLoss,
} from '#/features/voice/native-screen-publication-loss'
import {
  nativeMediaEngineStatsStore,
} from '#/features/voice/native-media-engine-stats'
import { shouldUseNativeScreenShare } from '#/features/voice/native-screen-share-mode'
import {
  findNativeScreenPublication,
  waitForNativeScreenPublication,
} from '#/features/voice/voice-publication-observer'
import {
  publishNativeScreenShare,
  type NativeScreenShareSession,
} from '#/features/voice/native-screen-share-publish'
import {
  clearNativePickerSelection,
  rejectNativePickerSelection,
  waitForNativePickerSelection,
} from '#/features/voice/native-screen-share-session'
import { getSyrnikeDesktop } from '#/platform/runtime'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import type {
  LiveKitNativePublisherCredentials,
} from '#/features/voice/voice-join'
import type {
  NativeMediaAction,
  NativeMediaState,
} from '#/features/voice/native-media-coordinator'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'
import { resolveScreenShareCaptureLimits } from '#/features/voice/voice-screen-share-limits'
import { playUiSound } from '#/features/sounds/sound-player'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import type { MutableRef } from '#/features/voice/voice-types'

type PendingScreenShareStart = {
  quality: ScreenShareQualityName
  withAudio: boolean
}

export type UseVoiceScreenShareOptions = {
  roomRef: MutableRef<Room | null>
  channelIdRef: MutableRef<string | null>
  status: VoiceStatus
  statusRef: MutableRef<VoiceStatus>
  localVoiceReady: boolean
  localVoiceReadyRef: MutableRef<boolean>
  screenShareStarting: boolean
  screenShareStartingRef: MutableRef<boolean>
  pendingScreenShareStartRef: MutableRef<PendingScreenShareStart | null>
  screenShareStartGenerationRef: MutableRef<number>
  screenShareDebugUntilRef: MutableRef<number>
  nativeScreenShareRef: MutableRef<NativeScreenShareSession | null>
  stoppedNativeScreenIdentityRef: MutableRef<string | null>
  nativeScreenPublicationLossKeyRef: MutableRef<string | null>
  nativeMediaStateRef: MutableRef<NativeMediaState>
  getActiveVoiceOperationId: () => string | null
  getUserId: () => string | null
  isCurrentVoiceSession: (room: Room, targetChannelId: string | null) => boolean
  activeChannelAudioBitrateKbps: () => number
  refreshNativeLiveKitCredentials: (
    mediaKind: 'screen',
    forceRefresh?: boolean,
  ) => Promise<LiveKitNativePublisherCredentials>
  setScreenShareDebugRun: (updater: (run: number) => number) => void
  setScreenShareStarting: (starting: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  dispatchNativeMedia: (action: NativeMediaAction) => void
  syncRoomParticipants: () => void
}

export function useVoiceScreenShare({
  roomRef,
  channelIdRef,
  status,
  statusRef,
  localVoiceReady,
  localVoiceReadyRef,
  screenShareStarting,
  screenShareStartingRef,
  pendingScreenShareStartRef,
  screenShareStartGenerationRef,
  screenShareDebugUntilRef,
  nativeScreenShareRef,
  stoppedNativeScreenIdentityRef,
  nativeScreenPublicationLossKeyRef,
  nativeMediaStateRef,
  getActiveVoiceOperationId,
  getUserId,
  isCurrentVoiceSession,
  activeChannelAudioBitrateKbps,
  refreshNativeLiveKitCredentials,
  setScreenShareDebugRun,
  setScreenShareStarting,
  setScreenShareEnabled,
  dispatchNativeMedia,
  syncRoomParticipants,
}: UseVoiceScreenShareOptions) {
  const stopNativeScreenShare = useCallback(async () => {
    await stopNativeScreenShareFromDeps({
      nativeScreenShareRef,
      nativeScreenPublicationLossKeyRef,
      screenShareStartingRef,
      stoppedNativeScreenIdentityRef,
      resetNativeMediaEngineStats: () => nativeMediaEngineStatsStore.reset(),
      dispatchNativeMedia,
      logVoiceDebugAgent,
    })
  }, [
    dispatchNativeMedia,
    nativeScreenPublicationLossKeyRef,
    nativeScreenShareRef,
    screenShareStartingRef,
    stoppedNativeScreenIdentityRef,
  ])

  const handleNativeScreenPublicationLost = useCallback(
    (loss: NativeScreenPublicationLoss) => {
      handleNativeScreenPublicationLostFromDeps({
        nativeMediaStateRef,
        nativeScreenPublicationLossKeyRef,
        nativeScreenShareRef,
        dispatchNativeMedia,
        setScreenShareEnabled,
        syncRoomParticipants,
        toastError: (message) => toast.error(message),
        stopNativeScreenShare,
        logVoiceDebugAgent,
      }, loss)
    },
    [
      dispatchNativeMedia,
      nativeMediaStateRef,
      nativeScreenPublicationLossKeyRef,
      nativeScreenShareRef,
      setScreenShareEnabled,
      stopNativeScreenShare,
      syncRoomParticipants,
    ],
  )

  const startLocalScreenShare = useCallback(
    async (quality: ScreenShareQualityName, withAudio: boolean) => {
      await startLocalScreenShareFromDeps({
        quality,
        withAudio,
        roomRef,
        channelIdRef,
        statusRef,
        localVoiceReadyRef,
        screenShareStartingRef,
        pendingScreenShareStartRef,
        screenShareStartGenerationRef,
        screenShareDebugUntilRef,
        nativeScreenShareRef,
        stoppedNativeScreenIdentityRef,
        nativeScreenPublicationLossKeyRef,
        getActiveVoiceOperationId,
        getUserId,
        isCurrentVoiceSession,
        createRequestId: () => crypto.randomUUID(),
        nowMs: () => Date.now(),
        performanceNow: () => performance.now(),
        setScreenShareDebugRun,
        setScreenShareStarting,
        setScreenShareEnabled,
        dispatchNativeMedia,
        syncRoomParticipants,
        stopNativeScreenShare,
        refreshNativeLiveKitCredentials,
        activeChannelAudioBitrateKbps,
        logVoiceDebugAgent,
        toastError: (message) => toast.error(message),
        playUiSound,
        setChromiumNativeMediaStats: () => {
          nativeMediaEngineStatsStore.setChromium()
        },
        warn: (message, detail) => console.warn(message, detail),
        readVoicePreferences,
        setScreenShareQualityPreference: (nextQuality) => {
          voicePreferenceStore.setScreenShareQuality(nextQuality)
        },
        setScreenShareAudioPreference: (nextWithAudio) => {
          voicePreferenceStore.setScreenShareAudio(nextWithAudio)
        },
        getDesktop: getSyrnikeDesktop,
        shouldUseNativeScreenShare,
        resolveScreenShareCaptureLimits,
        waitForNativePickerSelection,
        clearNativePickerSelection,
        rejectNativePickerSelection,
        publishNativeScreenShare,
        findNativeScreenPublication,
        waitForNativeScreenPublication,
        isLiveKitTokenFailure,
        resetNativeMediaEngineStats: () => nativeMediaEngineStatsStore.reset(),
      })
    },
    [
      activeChannelAudioBitrateKbps,
      channelIdRef,
      dispatchNativeMedia,
      getActiveVoiceOperationId,
      getUserId,
      isCurrentVoiceSession,
      localVoiceReadyRef,
      nativeScreenPublicationLossKeyRef,
      nativeScreenShareRef,
      pendingScreenShareStartRef,
      refreshNativeLiveKitCredentials,
      roomRef,
      screenShareDebugUntilRef,
      screenShareStartGenerationRef,
      screenShareStartingRef,
      setScreenShareDebugRun,
      setScreenShareEnabled,
      setScreenShareStarting,
      statusRef,
      stopNativeScreenShare,
      stoppedNativeScreenIdentityRef,
      syncRoomParticipants,
    ],
  )

  useEffect(() => {
    if (status !== 'connected' || !localVoiceReady) return
    if (screenShareStartingRef.current || nativeScreenShareRef.current) return
    const pending = pendingScreenShareStartRef.current
    if (!pending) return
    pendingScreenShareStartRef.current = null
    logVoiceDebugAgent({
      hypothesis: 'H6-screen-start-before-local-voice-ready',
      event: 'screen-start-resumed-after-local-voice-ready',
    })
    void startLocalScreenShare(pending.quality, pending.withAudio)
  }, [
    localVoiceReady,
    nativeScreenShareRef,
    pendingScreenShareStartRef,
    screenShareStartingRef,
    startLocalScreenShare,
    status,
  ])

  const teardownAfterUserToggle = useCallback(() => {
    teardownScreenShare(
      { setScreenShareEnabled, syncRoomParticipants, playUiSound },
      { reason: 'user-toggle', playStoppedSound: true },
    )
  }, [setScreenShareEnabled, syncRoomParticipants])

  const toggleScreenShare = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    if (screenShareStarting) return
    if (pendingScreenShareStartRef.current) {
      pendingScreenShareStartRef.current = null
      return
    }

    if (room.localParticipant.isScreenShareEnabled || nativeScreenShareRef.current) {
      if (nativeScreenShareRef.current) {
        void stopNativeScreenShare()
          .then(teardownAfterUserToggle)
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
        .then(teardownAfterUserToggle)
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось остановить демонстрацию',
          )
        })
      return
    }

    const prefs = readVoicePreferences()
    void startLocalScreenShare(prefs.screenShareQuality, prefs.screenShareAudio)
  }, [
    nativeScreenShareRef,
    pendingScreenShareStartRef,
    roomRef,
    screenShareStarting,
    startLocalScreenShare,
    stopNativeScreenShare,
    teardownAfterUserToggle,
  ])

  return {
    stopNativeScreenShare,
    handleNativeScreenPublicationLost,
    toggleScreenShare,
  }
}
