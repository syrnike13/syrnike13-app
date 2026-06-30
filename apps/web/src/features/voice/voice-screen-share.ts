import type { Room } from 'livekit-client'

import {
  screenShareAudioCaptureOptions,
  screenShareCaptureOptions,
  screenShareCombinedPublishOptions,
  type ScreenShareCaptureLimits,
} from '#/features/voice/voice-capture'
import type { VoiceStageMediaPublication } from '#/features/voice/voice-context'
import { localParticipantVoiceFlags } from '#/features/voice/voice-participant-media'
import type {
  ScreenShareCaptureMode,
  ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import type { RtcDebugSnapshot } from '#/features/voice/voice-rtc-debug'
import type {
  NativeMediaAction,
  NativeMediaState,
} from '#/features/voice/native-media-coordinator'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'
import { tuneScreenShareAfterPublish } from '#/features/voice/voice-screen-share-tuning'

type MutableRef<T> = {
  current: T
}

type NativeScreenShareSessionLike = {
  nativeParticipantIdentity?: string | null
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  audio?: unknown
  stop: () => Promise<unknown> | unknown
}

type VoiceDebugAgentPayload = Record<string, unknown> & {
  hypothesis: string
  event: string
}

export type NativeScreenPublicationLossReason =
  | 'participant-disconnected'
  | 'track-unpublished'
  | 'publication-missing'

export type NativeScreenPublicationLoss = {
  reason: NativeScreenPublicationLossReason
  participantIdentity: string
  publicationSid?: string
  remoteParticipants?: number
}

export type NativeScreenPublicationLossHandler = (
  loss: NativeScreenPublicationLoss,
) => void

export type StopNativeScreenShareDeps = {
  nativeScreenShareRef: MutableRef<NativeScreenShareSessionLike | null>
  nativeScreenPublicationLossKeyRef: MutableRef<string | null>
  screenShareStartingRef: MutableRef<boolean>
  stoppedNativeScreenIdentityRef: MutableRef<string | null>
  resetNativeMediaEngineStats: () => void
  dispatchNativeMedia: (action: { type: 'screen_stopped' }) => void
  logVoiceDebugAgent: (entry: VoiceDebugAgentPayload) => void
}

export type HandleNativeScreenPublicationLostDeps = {
  nativeMediaStateRef: MutableRef<NativeMediaState>
  nativeScreenPublicationLossKeyRef: MutableRef<string | null>
  nativeScreenShareRef: MutableRef<NativeScreenShareSessionLike | null>
  dispatchNativeMedia: (action: { type: 'screen_stopped' }) => void
  setScreenShareEnabled: (enabled: boolean) => void
  syncRoomParticipants: () => void
  toastError: (message: string) => void
  stopNativeScreenShare: () => Promise<void>
  logVoiceDebugAgent: (entry: VoiceDebugAgentPayload) => void
}

export type StartBrowserScreenShareDeps = {
  room: Room
  quality: ScreenShareQualityName
  withAudio: boolean
  limits?: ScreenShareCaptureLimits
  activeChannelAudioBitrateKbps: () => number
  setScreenShareEnabled: (enabled: boolean) => void
  syncRoomParticipants: () => void
  playUiSound: (sound: 'screen_share.stopped') => void
  setChromiumNativeMediaStats: () => void
}

type PendingScreenShareStart = {
  quality: ScreenShareQualityName
  withAudio: boolean
}

type VoiceScreenSharePreferences = {
  screenShareCaptureMode: ScreenShareCaptureMode
}

type NativeDisplayPickerSelection = {
  sourceId: string
  audioRequested: boolean
}

type DesktopScreenShareRuntime = {
  platform: {
    os: string
  }
  media: {
    openDisplayPicker: (withAudio: boolean) => Promise<unknown> | unknown
    cancelPendingStarts: (kind: 'screen') => Promise<unknown> | unknown
    disconnectPreparedScreenSession: () => Promise<unknown> | unknown
  }
}

type LiveKitNativePublisherCredentials = {
  url: string
  token: string
  participantIdentity: string
}

type NativeScreenPublication = {
  participantIdentity: string
  publicationSid: string
}

export type StartLocalScreenShareDeps = {
  quality: ScreenShareQualityName
  withAudio: boolean
  roomRef: MutableRef<Room | null>
  channelIdRef: MutableRef<string | null>
  statusRef: MutableRef<VoiceStatus>
  localVoiceReadyRef: MutableRef<boolean>
  screenShareStartingRef: MutableRef<boolean>
  pendingScreenShareStartRef: MutableRef<PendingScreenShareStart | null>
  screenShareStartGenerationRef: MutableRef<number>
  screenShareDebugUntilRef: MutableRef<number>
  nativeScreenShareRef: MutableRef<NativeScreenShareSessionLike | null>
  stoppedNativeScreenIdentityRef: MutableRef<string | null>
  nativeScreenPublicationLossKeyRef: MutableRef<string | null>
  getActiveVoiceOperationId: () => string | null
  getUserId: () => string | undefined
  isCurrentVoiceSession: (room: Room, targetChannelId: string | null) => boolean
  createRequestId: () => string
  nowMs: () => number
  performanceNow: () => number
  setScreenShareDebugRun: (updater: (run: number) => number) => void
  setScreenShareStarting: (starting: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  dispatchNativeMedia: (action: NativeMediaAction) => void
  syncRoomParticipants: () => void
  stopNativeScreenShare: () => Promise<void>
  startBrowserScreenShare: (
    room: Room,
    quality: ScreenShareQualityName,
    withAudio: boolean,
    limits?: ScreenShareCaptureLimits,
  ) => Promise<void>
  refreshNativeLiveKitCredentials: (
    mediaKind: 'screen',
    forceRefresh?: boolean,
  ) => Promise<LiveKitNativePublisherCredentials>
  activeChannelAudioBitrateKbps: () => number
  logVoiceDebugAgent: (entry: VoiceDebugAgentPayload) => void
  toastError: (message: string) => void
  playUiSound: (sound: 'screen_share.started') => void
  warn: (message: string, detail: string) => void
  readVoicePreferences: () => VoiceScreenSharePreferences
  setScreenShareQualityPreference: (quality: ScreenShareQualityName) => void
  setScreenShareAudioPreference: (withAudio: boolean) => void
  getDesktop: () => DesktopScreenShareRuntime | null | undefined
  shouldUseNativeScreenShare: (captureMode: ScreenShareCaptureMode) => boolean
  resolveScreenShareCaptureLimits: () => Promise<ScreenShareCaptureLimits>
  waitForNativePickerSelection: () => Promise<NativeDisplayPickerSelection>
  clearNativePickerSelection: () => void
  rejectNativePickerSelection: (error: Error) => void
  publishNativeScreenShare: (
    room: Room,
    localParticipant: Room['localParticipant'],
    sourceId: string,
    requestId: string,
    quality: ScreenShareQualityName,
    withAudio: boolean,
    audioBitrateKbps: number,
    onSidecarLost: (message: string) => void,
    onEnded: () => void,
    credentials: LiveKitNativePublisherCredentials,
    limits: ScreenShareCaptureLimits,
  ) => Promise<NativeScreenShareSessionLike>
  findNativeScreenPublication: (
    room: Room,
    options: {
      userId: string | undefined
      nativeParticipantIdentity?: string
    },
  ) => NativeScreenPublication | null
  waitForNativeScreenPublication: (
    room: Room,
    options: {
      userId: string | undefined
      nativeParticipantIdentity?: string
    },
    timeoutMs: number,
  ) => Promise<NativeScreenPublication>
  isLiveKitTokenFailure: (error: unknown) => boolean
  resetNativeMediaEngineStats: () => void
}

export function rtcDebugScreenSlice(snapshot: RtcDebugSnapshot) {
  const localScreen = snapshot.screenShares.find((screen) => screen.isLocal)
  const remoteScreen = snapshot.screenShares.find((screen) => !screen.isLocal)
  const outboundVideo = snapshot.outbound.find(
    (stream) => stream.pcRole === 'publisher' && stream.kind === 'video',
  )
  const inboundVideo = snapshot.inbound.find(
    (stream) => stream.pcRole === 'subscriber' && stream.kind === 'video',
  )

  return {
    transport: {
      availableOutgoingBitrate: snapshot.transport.availableOutgoingBitrate,
      availableIncomingBitrate: snapshot.transport.availableIncomingBitrate,
      outboundBitrate: snapshot.rates?.transport.outboundBitrate,
      inboundBitrate: snapshot.rates?.transport.inboundBitrate,
      pingMs: snapshot.transport.pingMs,
    },
    outboundVideo: outboundVideo
      ? {
          bitrate: outboundVideo.bitrate,
          targetBitrate: outboundVideo.targetBitrate,
          framesEncoded: outboundVideo.framesEncoded,
          framesPerSecond: outboundVideo.framesPerSecond,
          frameWidth: outboundVideo.frameWidth,
          frameHeight: outboundVideo.frameHeight,
          qualityLimitationReason: outboundVideo.qualityLimitationReason,
          nackCount: outboundVideo.nackCount,
          pliCount: outboundVideo.pliCount,
        }
      : null,
    inboundVideo: inboundVideo
      ? {
          bitrate: inboundVideo.bitrate,
          framesDecoded: inboundVideo.framesDecoded,
          framesDropped: inboundVideo.framesDropped,
          framesPerSecond: inboundVideo.framesPerSecond,
          frameWidth: inboundVideo.frameWidth,
          frameHeight: inboundVideo.frameHeight,
          packetsLost: inboundVideo.packetsLost,
          jitter: inboundVideo.jitter,
          freezeCount: inboundVideo.freezeCount,
        }
      : null,
    localScreen: localScreen
      ? {
          live: localScreen.live,
          subscribed: localScreen.subscribed,
          captureBackend: localScreen.captureBackend,
          maxBitrate: localScreen.maxBitrate,
          maxFramerate: localScreen.maxFramerate,
          sentBitrate: localScreen.sentBitrate,
          fps: localScreen.fps,
          frameWidth: localScreen.frameWidth,
          frameHeight: localScreen.frameHeight,
          captureWidth: localScreen.captureWidth,
          captureHeight: localScreen.captureHeight,
          captureFrameRate: localScreen.captureFrameRate,
          captureVideoPublished: localScreen.captureVideoPublished,
          captureVideoFrames: localScreen.captureVideoFrames,
          captureVideoIntervalFrames: localScreen.captureVideoIntervalFrames,
          captureVideoLateFrames: localScreen.captureVideoLateFrames,
          captureVideoNoFrameCount: localScreen.captureVideoNoFrameCount,
          captureVideoRepeatedFrameCount:
            localScreen.captureVideoRepeatedFrameCount,
          captureVideoAvgCaptureUs: localScreen.captureVideoAvgCaptureUs,
          captureVideoAvgReadbackUs: localScreen.captureVideoAvgReadbackUs,
          captureVideoAvgScaleUs: localScreen.captureVideoAvgScaleUs,
          captureVideoAvgPublishUs: localScreen.captureVideoAvgPublishUs,
          captureThreadMmcss: localScreen.captureThreadMmcss,
          captureAudioPublished: localScreen.captureAudioPublished,
          captureAudioFrames: localScreen.captureAudioFrames,
          captureAudioPackets: localScreen.captureAudioPackets,
        }
      : null,
    remoteScreen: remoteScreen
      ? {
          live: remoteScreen.live,
          subscribed: remoteScreen.subscribed,
          receivedBitrate: remoteScreen.receivedBitrate,
          fps: remoteScreen.fps,
          frameWidth: remoteScreen.frameWidth,
          frameHeight: remoteScreen.frameHeight,
          packetsLost: remoteScreen.packetsLost,
        }
      : null,
  }
}

export async function stopNativeScreenShare(
  deps: StopNativeScreenShareDeps,
) {
  const active = deps.nativeScreenShareRef.current
  if (!active) return
  deps.nativeScreenPublicationLossKeyRef.current = null
  deps.logVoiceDebugAgent({
    hypothesis: 'H3-stage-native-screen-loss,H4-native-stop-timeout',
    event: 'web-stop-native-screen-share',
    hasNativeParticipantIdentity: Boolean(active.nativeParticipantIdentity),
  })
  deps.nativeScreenShareRef.current = null
  deps.screenShareStartingRef.current = false
  deps.stoppedNativeScreenIdentityRef.current =
    active.nativeParticipantIdentity ?? null
  deps.resetNativeMediaEngineStats()
  deps.dispatchNativeMedia({ type: 'screen_stopped' })
  await active.stop()
}

export function handleNativeScreenPublicationLost(
  deps: HandleNativeScreenPublicationLostDeps,
  loss: NativeScreenPublicationLoss,
) {
  const screen = deps.nativeMediaStateRef.current.screen
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
  if (deps.nativeScreenPublicationLossKeyRef.current === lossKey) return
  deps.nativeScreenPublicationLossKeyRef.current = lossKey

  deps.logVoiceDebugAgent({
    hypothesis: 'H3-stage-native-screen-loss',
    event: 'native-screen-publication-lost',
    reason: loss.reason,
    participantIdentity: loss.participantIdentity,
    publicationSid: loss.publicationSid,
    remoteParticipants: loss.remoteParticipants,
  })

  if (!deps.nativeScreenShareRef.current) {
    deps.dispatchNativeMedia({ type: 'screen_stopped' })
    deps.setScreenShareEnabled(false)
    deps.syncRoomParticipants()
    deps.toastError('Демонстрация экрана отключилась')
    return
  }

  void deps.stopNativeScreenShare()
    .catch((error) => {
      deps.logVoiceDebugAgent({
        hypothesis: 'H3-stage-native-screen-loss',
        event: 'native-screen-publication-lost-stop-failed',
        reason: loss.reason,
        message: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      deps.setScreenShareEnabled(false)
      deps.syncRoomParticipants()
      deps.toastError('Демонстрация экрана отключилась')
    })
}

export async function startBrowserScreenShare(
  deps: StartBrowserScreenShareDeps,
) {
  const capture = screenShareCaptureOptions(deps.quality, deps.limits)
  const publication = await deps.room.localParticipant.setScreenShareEnabled(
    true,
    {
      ...capture.capture,
      audio: screenShareAudioCaptureOptions(deps.withAudio),
    },
    deps.withAudio
      ? screenShareCombinedPublishOptions(
          deps.quality,
          deps.activeChannelAudioBitrateKbps(),
          deps.limits,
        )
      : capture.publish,
  )
  if (publication) {
    ;(publication as VoiceStageMediaPublication).options = {
      videoCodec: capture.publish.videoCodec,
      simulcast: capture.publish.simulcast,
      degradationPreference: capture.publish.degradationPreference,
      screenShareEncoding: capture.publish.screenShareEncoding,
    }
  }

  deps.setChromiumNativeMediaStats()

  const videoTrack = publication?.videoTrack
  if (videoTrack?.mediaStreamTrack) {
    videoTrack.mediaStreamTrack.contentHint = capture.capture.contentHint
    await tuneScreenShareAfterPublish(
      deps.room,
      videoTrack.mediaStreamTrack,
      deps.quality,
      deps.limits,
    )
  }

  videoTrack?.on('ended', () => {
    void deps.room.localParticipant.setScreenShareEnabled(false).then(() => {
      deps.setScreenShareEnabled(
        localParticipantVoiceFlags(deps.room.localParticipant).screensharing,
      )
      deps.playUiSound('screen_share.stopped')
      deps.syncRoomParticipants()
    })
  })
}

export async function startLocalScreenShare(
  deps: StartLocalScreenShareDeps,
) {
  const room = deps.roomRef.current
  if (!room) return
  const targetChannelId = deps.channelIdRef.current
  if (!targetChannelId) return
  if (!deps.isCurrentVoiceSession(room, targetChannelId)) return
  if (deps.screenShareStartingRef.current || deps.nativeScreenShareRef.current) {
    return
  }
  if (!deps.localVoiceReadyRef.current) {
    deps.pendingScreenShareStartRef.current = {
      quality: deps.quality,
      withAudio: deps.withAudio,
    }
    deps.logVoiceDebugAgent({
      hypothesis: 'H6-screen-start-before-local-voice-ready',
      event: 'screen-start-deferred-local-voice-not-ready',
      voiceStatus: deps.statusRef.current,
      roomState: room.state,
    })
    return
  }
  const startGeneration = deps.screenShareStartGenerationRef.current + 1
  deps.screenShareStartGenerationRef.current = startGeneration
  const requestId = deps.createRequestId()
  const debugStartedAt = deps.performanceNow()
  deps.screenShareDebugUntilRef.current = deps.nowMs() + 30_000
  deps.setScreenShareDebugRun((run) => run + 1)
  const screenOperationId =
    deps.getActiveVoiceOperationId() ?? `screen:${startGeneration}`
  const isCurrentScreenShareStart = () =>
    deps.screenShareStartGenerationRef.current === startGeneration &&
    deps.isCurrentVoiceSession(room, targetChannelId)
  const clearCurrentScreenShareStart = () => {
    if (deps.screenShareStartGenerationRef.current !== startGeneration) return
    deps.screenShareStartingRef.current = false
    deps.setScreenShareStarting(false)
  }

  deps.setScreenShareQualityPreference(deps.quality)
  deps.setScreenShareAudioPreference(deps.withAudio)
  deps.screenShareStartingRef.current = true
  deps.setScreenShareStarting(true)

  const prefs = deps.readVoicePreferences()
  const desktop = deps.getDesktop()
  const useNative = deps.shouldUseNativeScreenShare(
    prefs.screenShareCaptureMode,
  )
  const screenShareLimits = await deps.resolveScreenShareCaptureLimits()
  deps.logVoiceDebugAgent({
    hypothesis: 'H1-screen-start-lifecycle',
    event: 'screen-start-requested',
    elapsedMs: 0,
    quality: deps.quality,
    withAudio: deps.withAudio,
    requestedNative: useNative,
    useNative: Boolean(useNative && desktop),
    hasDesktopRuntime: Boolean(desktop),
    voiceStatus: deps.statusRef.current,
    roomState: room.state,
    limits: screenShareLimits,
  })

  try {
    if (useNative && desktop) {
      deps.dispatchNativeMedia({
        type: 'screen_start_requested',
        operationId: screenOperationId,
        channelId: targetChannelId,
        requestId,
      })
      deps.stoppedNativeScreenIdentityRef.current = null
      deps.nativeScreenPublicationLossKeyRef.current = null
      const pickerPromise = deps.waitForNativePickerSelection()
      await desktop.media.openDisplayPicker(deps.withAudio)
      const selection = await pickerPromise
      deps.logVoiceDebugAgent({
        hypothesis: 'H1-screen-start-lifecycle',
        event: 'native-picker-selected',
        elapsedMs: Math.round(deps.performanceNow() - debugStartedAt),
        audioRequested: selection.audioRequested,
      })
      if (!isCurrentScreenShareStart()) {
        clearCurrentScreenShareStart()
        void Promise.resolve(
          desktop.media.cancelPendingStarts('screen'),
        ).catch(() => {})
        void Promise.resolve(
          desktop.media.disconnectPreparedScreenSession(),
        ).catch(() => {})
        return
      }
      deps.setScreenShareAudioPreference(selection.audioRequested)
      const handleSidecarLost = (message: string) => {
        deps.warn('[voice] native media engine lost', message)
        deps.toastError('Нативный захват прерван')
        deps.dispatchNativeMedia({
          type: 'screen_failed',
          operationId: screenOperationId,
          channelId: targetChannelId,
          error: message,
        })
        void deps.stopNativeScreenShare().catch(() => {})
        deps.setScreenShareEnabled(false)
        deps.syncRoomParticipants()
      }
      let session: NativeScreenShareSessionLike | null = null
      const handleNativeScreenEnded = () => {
        const active = deps.nativeScreenShareRef.current
        if (!active || active !== session) return
        deps.nativeScreenShareRef.current = null
        deps.stoppedNativeScreenIdentityRef.current =
          active.nativeParticipantIdentity ?? null
        deps.resetNativeMediaEngineStats()
        deps.dispatchNativeMedia({ type: 'screen_stopped' })
        deps.setScreenShareEnabled(false)
        clearCurrentScreenShareStart()
        deps.syncRoomParticipants()
      }
      const startNative = async (forceRefresh: boolean) => {
        if (!isCurrentScreenShareStart()) {
          return null
        }
        return deps.publishNativeScreenShare(
          room,
          room.localParticipant,
          selection.sourceId,
          requestId,
          deps.quality,
          selection.audioRequested,
          deps.activeChannelAudioBitrateKbps(),
          handleSidecarLost,
          handleNativeScreenEnded,
          await deps.refreshNativeLiveKitCredentials('screen', forceRefresh),
          screenShareLimits,
        )
      }

      try {
        session = await startNative(false)
      } catch (error) {
        if (!deps.isLiveKitTokenFailure(error)) throw error
        await deps.stopNativeScreenShare()
        session = await startNative(true)
      }
      if (!session) {
        throw new Error('Native screen share did not start')
      }
      deps.logVoiceDebugAgent({
        hypothesis: 'H1-screen-start-lifecycle',
        event: 'native-session-started',
        elapsedMs: Math.round(deps.performanceNow() - debugStartedAt),
        width: session.width,
        height: session.height,
        fps: session.fps,
        bitrate: session.bitrate,
        hasAudio: Boolean(session.audio),
        hasNativeParticipantIdentity: Boolean(
          session.nativeParticipantIdentity,
        ),
      })
      if (!isCurrentScreenShareStart()) {
        await Promise.resolve(session.stop()).catch(() => {})
        return
      }
      deps.nativeScreenShareRef.current = session
      const publicationOptions = {
        userId: deps.getUserId(),
        nativeParticipantIdentity: session.nativeParticipantIdentity ?? undefined,
      }
      const observedPublication =
        deps.findNativeScreenPublication(room, publicationOptions) ??
        (await deps.waitForNativeScreenPublication(
          room,
          publicationOptions,
          10_000,
        ))
      if (!isCurrentScreenShareStart()) {
        await Promise.resolve(session.stop()).catch(() => {})
        return
      }
      deps.dispatchNativeMedia({
        type: 'screen_publication_observed',
        operationId: screenOperationId,
        channelId: targetChannelId,
        participantIdentity: observedPublication.participantIdentity,
        publicationSid: observedPublication.publicationSid,
      })
      deps.logVoiceDebugAgent({
        hypothesis: 'H3-remote-decode-lag',
        event: 'native-publication-observed',
        elapsedMs: Math.round(deps.performanceNow() - debugStartedAt),
        hasParticipantIdentity: Boolean(
          observedPublication.participantIdentity,
        ),
        hasPublicationSid: Boolean(observedPublication.publicationSid),
      })
      deps.setScreenShareEnabled(true)
      deps.playUiSound('screen_share.started')
      clearCurrentScreenShareStart()
      deps.syncRoomParticipants()
      return
    }

    if (desktop?.platform.os === 'win32') {
      throw new Error('Нативный media engine недоступен')
    }

    await deps.startBrowserScreenShare(
      room,
      deps.quality,
      deps.withAudio,
      screenShareLimits,
    )
    deps.logVoiceDebugAgent({
      hypothesis: 'H5-browser-sender-tuning-miss',
      event: 'browser-screen-started',
      elapsedMs: Math.round(deps.performanceNow() - debugStartedAt),
      quality: deps.quality,
      withAudio: deps.withAudio,
    })
    if (!isCurrentScreenShareStart()) {
      await room.localParticipant.setScreenShareEnabled(false).catch(() => {})
      clearCurrentScreenShareStart()
      return
    }
    deps.setScreenShareEnabled(
      localParticipantVoiceFlags(room.localParticipant).screensharing,
    )
    deps.playUiSound('screen_share.started')
    clearCurrentScreenShareStart()
    deps.syncRoomParticipants()
  } catch (error) {
    if (!isCurrentScreenShareStart()) {
      return
    }
    deps.logVoiceDebugAgent({
      hypothesis: 'H1-screen-start-lifecycle',
      event: 'screen-start-failed',
      elapsedMs: Math.round(deps.performanceNow() - debugStartedAt),
      message: error instanceof Error ? error.message : String(error),
      useNative: Boolean(useNative && desktop),
    })
    clearCurrentScreenShareStart()
    deps.dispatchNativeMedia({
      type: 'screen_failed',
      operationId: screenOperationId,
      channelId: targetChannelId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (desktop?.platform.os === 'win32') {
      await Promise.resolve(desktop.media.cancelPendingStarts('screen')).catch(
        () => {},
      )
      await deps.stopNativeScreenShare().catch(() => {})
      deps.clearNativePickerSelection()
    }
    deps.rejectNativePickerSelection(
      error instanceof Error
        ? error
        : new Error('Не удалось начать демонстрацию экрана'),
    )
    deps.toastError(
      error instanceof Error
        ? error.message
        : 'Не удалось начать демонстрацию экрана',
    )
  }
}
