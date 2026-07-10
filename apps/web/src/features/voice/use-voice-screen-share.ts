import { useCallback, useEffect } from 'react'
import type { Room } from 'livekit-client'
import { toast } from 'sonner'

import {
  screenShareAudioCaptureOptions,
  screenShareCaptureOptions,
  screenShareCombinedPublishOptions,
  type ScreenShareCaptureLimits,
} from '#/features/voice/voice-capture'
import type {
  NativeScreenPublicationLoss,
} from '#/features/voice/native-screen-publication-loss'
import {
  nativeMediaEngineStatsStore,
} from '#/features/voice/native-media-engine-stats'
import { shouldUseNativeScreenShare } from '#/features/voice/native-screen-share-mode'
import {
  waitForNativeScreenPublication,
} from '#/features/voice/voice-publication-observer'
import type { NativeScreenShareSession } from '#/features/voice/native-screen-share-publish'
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
  NativeMediaAction,
  NativeMediaState,
} from '#/features/voice/native-media-coordinator'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'
import { resolveScreenShareCaptureLimits } from '#/features/voice/voice-screen-share-limits'
import { playUiSound } from '#/features/sounds/sound-player'
import {
  teardownScreenShare,
} from '#/features/voice/voice-screen-share'
import type { MutableRef } from '#/features/voice/voice-types'
import type { VoiceNativeMediaOwner } from '#/features/voice/voice-native-media-owner'

type PendingScreenShareStart = {
  quality: ScreenShareQualityName
  withAudio: boolean
}

type NativeDisplayPickerSelection = {
  sourceId: string
  audioRequested: boolean
}

type ScreenShareStartToken = {
  isCurrent: () => boolean
  clear: () => void
  cancel: () => void
}

export type UseVoiceScreenShareOptions = {
  nativeMedia: VoiceNativeMediaOwner
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
  setScreenShareDebugRun: (updater: (run: number) => number) => void
  setScreenShareStarting: (starting: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  dispatchNativeMedia: (action: NativeMediaAction) => void
  syncRoomParticipants: () => void
}

function createScreenShareStartToken(
  deps: UseVoiceScreenShareOptions,
  room: Room,
  targetChannelId: string,
  startGeneration: number,
): ScreenShareStartToken {
  return {
    isCurrent: () =>
      deps.screenShareStartGenerationRef.current === startGeneration &&
      deps.isCurrentVoiceSession(room, targetChannelId),
    clear: () => {
      if (deps.screenShareStartGenerationRef.current !== startGeneration) return
      deps.screenShareStartingRef.current = false
      deps.setScreenShareStarting(false)
    },
    cancel: () => {
      if (deps.screenShareStartGenerationRef.current !== startGeneration) return
      deps.screenShareStartGenerationRef.current += 1
      deps.screenShareStartingRef.current = false
      deps.setScreenShareStarting(false)
    },
  }
}

async function startBrowserScreenShare(
  room: Room,
  quality: ScreenShareQualityName,
  withAudio: boolean,
  limits: ScreenShareCaptureLimits,
  activeChannelAudioBitrateKbps: number,
  onEnded: () => void,
) {
  const capture = screenShareCaptureOptions(quality, limits)
  const publication = await room.localParticipant.setScreenShareEnabled(
    true,
    {
      ...capture.capture,
      audio: screenShareAudioCaptureOptions(withAudio),
    },
    withAudio
      ? screenShareCombinedPublishOptions(
          quality,
          activeChannelAudioBitrateKbps,
          limits,
        )
      : capture.publish,
  )

  publication?.videoTrack?.on('ended', () => {
    void room.localParticipant.setScreenShareEnabled(false).then(onEnded)
  })
}

function buildScreenSourceSpec(
  selection: NativeDisplayPickerSelection,
  quality: ScreenShareQualityName,
  limits: ScreenShareCaptureLimits,
  audioBitrateKbps: number,
) {
  const capture = screenShareCaptureOptions(quality, limits)
  return {
    sourceId: selection.sourceId,
    width: capture.capture.resolution.width,
    height: capture.capture.resolution.height,
    fps: capture.capture.resolution.frameRate ?? 30,
    bitrate:
      capture.publish.screenShareEncoding?.maxBitrate ??
      capture.publish.videoEncoding?.maxBitrate ??
      2_500_000,
    audioBitrate: audioBitrateKbps * 1000,
    audioRequested: selection.audioRequested,
  }
}

export function useVoiceScreenShare({
  nativeMedia,
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
  setScreenShareDebugRun,
  setScreenShareStarting,
  setScreenShareEnabled,
  dispatchNativeMedia,
  syncRoomParticipants,
}: UseVoiceScreenShareOptions) {
  const stopNativeScreenShare = useCallback(async () => {
    const active = nativeScreenShareRef.current
    if (!active) return
    nativeScreenShareRef.current = null
    nativeScreenPublicationLossKeyRef.current = null
    screenShareStartingRef.current = false
    stoppedNativeScreenIdentityRef.current =
      active.nativeParticipantIdentity ?? null
    nativeMediaEngineStatsStore.reset()
    dispatchNativeMedia({ type: 'screen_stopped' })
    await active.stop()
  }, [
    dispatchNativeMedia,
    nativeScreenPublicationLossKeyRef,
    nativeScreenShareRef,
    screenShareStartingRef,
    stoppedNativeScreenIdentityRef,
  ])

  const handleNativeScreenPublicationLost = useCallback(
    (loss: NativeScreenPublicationLoss) => {
      const screen = nativeMediaStateRef.current.screen
      if (screen.status !== 'published') return
      if (loss.participantIdentity !== screen.participantIdentity) return
      if (loss.publicationSid && loss.publicationSid !== screen.publicationSid) {
        return
      }

      const lossKey = [
        screen.operationId,
        screen.participantIdentity,
        screen.publicationSid,
        loss.reason,
      ].join(':')
      if (nativeScreenPublicationLossKeyRef.current === lossKey) return
      nativeScreenPublicationLossKeyRef.current = lossKey

      void stopNativeScreenShare()
        .catch(() => {})
        .finally(() => {
          teardownScreenShare(
            { setScreenShareEnabled, syncRoomParticipants, playUiSound },
            { reason: 'native-publication-lost' },
          )
          toast.error('Демонстрация экрана отключилась')
        })
    },
    [
      nativeMediaStateRef,
      nativeScreenPublicationLossKeyRef,
      setScreenShareEnabled,
      stopNativeScreenShare,
      syncRoomParticipants,
    ],
  )

  const startLocalScreenShare = useCallback(
    async (quality: ScreenShareQualityName, withAudio: boolean) => {
      const room = roomRef.current
      if (!room) return
      const targetChannelId = channelIdRef.current
      if (!targetChannelId) return
      if (!isCurrentVoiceSession(room, targetChannelId)) return
      if (screenShareStartingRef.current || nativeScreenShareRef.current) return
      if (!localVoiceReadyRef.current) {
        pendingScreenShareStartRef.current = { quality, withAudio }
        return
      }

      const startGeneration = screenShareStartGenerationRef.current + 1
      screenShareStartGenerationRef.current = startGeneration
      screenShareDebugUntilRef.current = Date.now() + 30_000
      setScreenShareDebugRun((run) => run + 1)
      screenShareStartingRef.current = true
      setScreenShareStarting(true)
      voicePreferenceStore.setScreenShareQuality(quality)
      voicePreferenceStore.setScreenShareAudio(withAudio)

      const currentStartToken = createScreenShareStartToken(
        {
          nativeMedia,
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
          setScreenShareDebugRun,
          setScreenShareStarting,
          setScreenShareEnabled,
          dispatchNativeMedia,
          syncRoomParticipants,
        },
        room,
        targetChannelId,
        startGeneration,
      )
      const screenOperationId =
        getActiveVoiceOperationId() ?? `screen:${startGeneration}`
      const screenShareLimits = await resolveScreenShareCaptureLimits()

      try {
        const prefs = readVoicePreferences()
        const desktop = getSyrnikeDesktop()
        const useNative =
          shouldUseNativeScreenShare(prefs.screenShareCaptureMode) && desktop

        if (useNative) {
          dispatchNativeMedia({
            type: 'screen_start_requested',
            operationId: screenOperationId,
            channelId: targetChannelId,
            requestId: `screen:${startGeneration}`,
          })
          stoppedNativeScreenIdentityRef.current = null
          nativeScreenPublicationLossKeyRef.current = null

          const pickerPromise = waitForNativePickerSelection()
          await Promise.resolve(desktop.media.openDisplayPicker(withAudio))
          const selection = (await pickerPromise) as NativeDisplayPickerSelection
          if (!currentStartToken.isCurrent()) {
            currentStartToken.cancel()
            await nativeMedia.stopScreenShare().catch(() => {})
            return
          }

          const source = buildScreenSourceSpec(
            selection,
            quality,
            screenShareLimits,
            activeChannelAudioBitrateKbps(),
          )
          const prepareRevision = await nativeMedia.prepareScreenShare(source)
          await nativeMedia.waitForScreenState(prepareRevision, [
            'prepared',
            'published',
          ])
          if (!currentStartToken.isCurrent()) {
            currentStartToken.cancel()
            await nativeMedia.stopScreenShare().catch(() => {})
            return
          }

          const publishRevision = await nativeMedia.publishScreenShare(source)
          const observedPublish = await nativeMedia.waitForScreenState(
            publishRevision,
            ['published'],
          )
          if (!currentStartToken.isCurrent()) {
            currentStartToken.cancel()
            await nativeMedia.stopScreenShare().catch(() => {})
            return
          }

          const publication = await waitForNativeScreenPublication(
            room,
            {
              userId: getUserId(),
              nativeParticipantIdentity:
                observedPublish.participantIdentity ?? undefined,
            },
            10_000,
          )
          if (!currentStartToken.isCurrent()) {
            currentStartToken.cancel()
            await nativeMedia.stopScreenShare().catch(() => {})
            return
          }

          nativeScreenShareRef.current = {
            nativeParticipantIdentity:
              observedPublish.participantIdentity ?? null,
            stop: async () => {
              await nativeMedia.stopScreenShare()
            },
          }
          dispatchNativeMedia({
            type: 'screen_publication_observed',
            operationId: screenOperationId,
            channelId: targetChannelId,
            participantIdentity: publication.participantIdentity,
            publicationSid: publication.publicationSid,
          })
          playUiSound('screen_share.started')
          currentStartToken.clear()
          setScreenShareEnabled(true)
          syncRoomParticipants()
          return
        }

        await startBrowserScreenShare(
          room,
          quality,
          withAudio,
          screenShareLimits,
          activeChannelAudioBitrateKbps(),
          () => {
            teardownScreenShare(
              { setScreenShareEnabled, syncRoomParticipants, playUiSound },
              {
                reason: 'browser-track-ended',
                screenShareEnabled: false,
                playStoppedSound: true,
              },
            )
          },
        )
        if (!currentStartToken.isCurrent()) {
          await room.localParticipant.setScreenShareEnabled(false).catch(() => {})
          currentStartToken.cancel()
          return
        }
        playUiSound('screen_share.started')
        currentStartToken.clear()
        setScreenShareEnabled(true)
        syncRoomParticipants()
      } catch (error) {
        if (!currentStartToken.isCurrent()) {
          return
        }
        currentStartToken.cancel()
        dispatchNativeMedia({
          type: 'screen_failed',
          operationId: screenOperationId,
          channelId: targetChannelId,
          error: error instanceof Error ? error.message : String(error),
        })
        await nativeMedia.stopScreenShare().catch(() => {})
        clearNativePickerSelection()
        rejectNativePickerSelection(
          error instanceof Error
            ? error
            : new Error('Не удалось начать демонстрацию экрана'),
        )
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось начать демонстрацию экрана',
        )
      }
    },
    [
      activeChannelAudioBitrateKbps,
      channelIdRef,
      dispatchNativeMedia,
      getActiveVoiceOperationId,
      getUserId,
      isCurrentVoiceSession,
      localVoiceReady,
      localVoiceReadyRef,
      nativeMedia,
      nativeMediaStateRef,
      nativeScreenPublicationLossKeyRef,
      nativeScreenShareRef,
      pendingScreenShareStartRef,
      roomRef,
      screenShareDebugUntilRef,
      screenShareStartGenerationRef,
      screenShareStarting,
      screenShareStartingRef,
      setScreenShareDebugRun,
      setScreenShareEnabled,
      setScreenShareStarting,
      status,
      statusRef,
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
