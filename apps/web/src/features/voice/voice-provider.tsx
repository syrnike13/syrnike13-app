import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  RoomEvent,
  Track,
  type Room,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import {
  VoiceDirector,
  createInactiveMediaSnapshot,
  type VoiceCommand,
  type VoiceMediaState,
  type VoiceSnapshot,
} from '@syrnike13/platform'
import { Effect, Fiber, Schedule } from 'effect'
import { toast } from 'sonner'

import { useAuth } from '#/features/auth/auth-context'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { callAudioBitrateBps } from '#/lib/channel-audio-bitrate'
import {
  getChannelVoiceParticipants,
  sameVoiceParticipantList,
} from '#/features/sync/voice-selectors'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { BrowserRtcEngineAdapter } from '#/features/voice/browser-rtc-engine-adapter'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import { VoiceTabOwner } from '#/features/voice/voice-tab-owner'
import { createWebVoiceAuthorityAdapter } from '#/features/voice/web-voice-authority-adapter'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import {
  nativeVideoRegistry,
  type NativeVideoRegistryPublication,
  type NativeVideoRegistryTrack,
} from '#/features/voice/native-video-registry'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import {
  buildVoiceMediaAvailabilityState,
  type VoiceMediaAvailabilityState,
} from '#/features/voice/voice-media-availability'
import {
  isCameraDeviceFailure,
  isLocalCameraPreviewActive,
  nextCameraEnabled,
} from '#/features/voice/camera-device-issue'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
import { nativeScreenShareProfileSettings } from '#/features/voice/voice-preference-types'
import {
  readStageMediaFilters,
  writeStageMediaFilters,
} from '#/features/voice/voice-stage-filters'
import {
  stageMediaItemId,
} from '#/features/voice/voice-stage-media'
import {
  applyStageScreenPublicationSubscription,
  setStageScreenSubscription,
  shouldSubscribeStageScreen,
  stageScreenMediaUserId,
} from '#/features/voice/voice-stage-subscription'
import {
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import type {
  VoiceConnectionPhase,
  VoiceMicIssue,
  VoiceStatus,
} from '#/features/voice/voice-mic-status'
import {
  VoiceMediaContext,
  type VoiceMediaContextValue,
} from '#/features/voice/voice-media-context'
import {
  VoiceSessionContext,
  type VoiceSessionContextValue,
} from '#/features/voice/voice-session-context'
import {
  VoiceStageContext,
  type VoiceStageContextValue,
} from '#/features/voice/voice-stage-context'
import {
  VoiceTelemetryContext,
  type VoiceTelemetryContextValue,
} from '#/features/voice/voice-telemetry-context'
import {
  setVoiceStageMediaPublicationSubscribed,
  type VoiceStageMediaItem,
  type VoiceStageMediaTrack,
} from '#/features/voice/voice-context'
import {
  buildStageItems,
  createStageRoomFromLiveKit,
} from '#/features/voice/voice-stage-items'
import { withConnectingLocalAvatarItem } from '#/features/voice/voice-connecting-preview'
import {
  attachRtcRatesToScreenShares,
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshotEffect,
  deriveRtcRates,
  rtcDebugSnapshotFromTelemetry,
  type RtcDebugSnapshot,
} from '#/features/voice/voice-rtc-debug'
import { RtcHealthMonitor } from '#/features/voice/rtc-health-monitor'
import {
  appendVoicePingSample,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { playUiSound } from '#/features/sounds/sound-player'
import type { SoundEventId } from '#/features/sounds/sound-events'
import {
  normalizeWatchedOwnerIds,
  sameWatchedOwnerIds,
  streamViewerSnapshot,
  streamViewerTransitionSound,
  type StreamViewerSnapshot,
} from '#/features/voice/stream-viewers'
import { eventsGateway } from '#/features/events/gateway'
import {
  createVoiceMediaLiveness,
  voiceSnapshotTransitionSounds,
} from '#/features/voice/voice-transition-sounds'
import { getSyrnikeDesktop } from '#/platform/runtime'
import { recordDiagnosticEvent } from '#/features/diagnostics/diagnostic-reporter'
import { enqueueAutomaticDiagnosticIncident } from '#/features/diagnostics/automatic-diagnostic-incidents'
import { useVoiceStagePresentation } from './use-voice-stage-presentation'
import { useStreamPreviewUpload } from './use-stream-preview-upload'

type VoiceClient = {
  dispatch(command: VoiceCommand): void
  snapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
  room(): Room | null
  subscribeRoom(listener: (room: Room | null) => void): () => void
  disposeEffect(): Effect.Effect<void, unknown>
  dispose(): Promise<void> | void
}

const INITIAL_SNAPSHOT: VoiceSnapshot = {
  intentChannelId: null,
  membershipChannelId: null,
  connection: 'disconnected',
  microphone: createInactiveMediaSnapshot(),
  output: createInactiveMediaSnapshot(),
  camera: createInactiveMediaSnapshot(),
  screen: createInactiveMediaSnapshot(),
  screenAudio: createInactiveMediaSnapshot(),
  userMuted: true,
  userDeafened: false,
  serverMuted: false,
  serverDeafened: false,
  systemPrivacyMuted: false,
  monitoringMuted: false,
  inputMode: 'voice_activity',
  pushToTalkHeld: false,
  effectiveMuted: true,
  speakingUserIds: [],
}

const DEVICE_FALLBACK_WARNINGS: Partial<Record<string, string>> = {
  output_device_fallback:
    'Выбранное устройство вывода недоступно. Используем устройство по умолчанию.',
  microphone_device_fallback:
    'Выбранный микрофон недоступен. Используем микрофон по умолчанию.',
}

let remoteAudioCommandRevision = 0
// Coalesces slider drags into at most one native mix update per interval.
const REMOTE_AUDIO_PUBLISH_INTERVAL_MS = 40

/** Сколько ждать перед звуком остановки стрима/камеры (см. playTransitionSound). */
const MEDIA_STOP_SOUND_GRACE_MS = 2_000

export function VoiceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const desktop = getSyrnikeDesktop()
  const [nativeVideoTracks, setNativeVideoTracks] = useState<NativeVideoRegistryTrack[]>([])
  const [nativeVideoPublications, setNativeVideoPublications] = useState<
    NativeVideoRegistryPublication[]
  >([])
  const [localScreenPreviewConsumerCount, setLocalScreenPreviewConsumerCount] =
    useState(0)
  useEffect(() => {
    if (!desktop) return
    nativeVideoRegistry.start()
    const update = () => {
      setNativeVideoTracks(nativeVideoRegistry.listTracks())
      setNativeVideoPublications(nativeVideoRegistry.listPublications())
      setLocalScreenPreviewConsumerCount(
        nativeVideoRegistry.getLocalScreenPreviewConsumerCount(),
      )
    }
    update()
    const unsubscribe = nativeVideoRegistry.subscribe(update)
    return () => {
      unsubscribe()
      nativeVideoRegistry.stop()
    }
  }, [desktop])
  const clientRef = useRef<VoiceClient | null>(null)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(INITIAL_SNAPSHOT)
  const [room, setRoom] = useState<Room | null>(null)
  const [roomRevision, setRoomRevision] = useState(0)
  const [nativeDemandRetryRevision, setNativeDemandRetryRevision] = useState(0)
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [focusedMediaId, setFocusedMediaIdState] = useState<string | null>(null)
  const [stageFocusNonce, setStageFocusNonce] = useState(0)
  const [stageFullscreen, setStageFullscreen] = useState(false)
  const [activityLauncherOpen, setActivityLauncherOpen] = useState(false)
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const [voicePingMs, setVoicePingMs] = useState<number | null>(null)
  const [voicePingHistory, setVoicePingHistory] = useState<VoicePingSample[]>([])
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
  const diagnosticRtcHistoryRef = useRef<RtcDebugSnapshot[]>([])
  const rtcHealthMonitorRef = useRef(new RtcHealthMonitor())
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const watchedScreenViewerChannelsRef = useRef(new Map<string, string>())
  const pendingScreenWatchIdsRef = useRef(new Set<string>())
  /** Пользователь сам выключил стрим/камеру: звук и флаг на сервере — сразу. */
  const intentionalMediaStopRef = useRef({ screen_share: false, camera: false })
  const screenRepublishGraceTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  )
  const nativeVideoDemandRef = useRef(new Map<string, boolean>())
  const nativeDemandRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const browserSubscriptionErrorsRef = useRef(new Map<string, string>())
  const setNativeVideoDemand = useCallback((
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) => {
    if (!desktop) return
    const demandKey = nativeVideoDemandKey(sessionId, generation, trackId)
    nativeVideoDemandRef.current.set(demandKey, demanded)
    if (demanded) nativeVideoRegistry.clearPublicationError(trackId)
    Effect.runFork(
      Effect.tryPromise({
        try: () =>
          desktop.media.setRemoteVideoDemand(
            sessionId,
            generation,
            trackId,
            demanded,
          ),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (nativeVideoDemandRef.current.get(demandKey) === demanded) {
              nativeVideoDemandRef.current.delete(demandKey)
            }
            if (nativeDemandRetryTimerRef.current == null) {
              nativeDemandRetryTimerRef.current = setTimeout(() => {
                nativeDemandRetryTimerRef.current = null
                setNativeDemandRetryRevision((revision) => revision + 1)
              }, 250)
            }
          }),
        ),
      ),
    )
  }, [desktop])
  const previousFailureRef = useRef<string | null>(null)
  const previousMediaFailureRef = useRef<string | null>(null)
  const voicePreferences = useVoicePreferences()
  const localScreenPreviewFps = desktop?.platform.os === 'win32'
    ? nativeScreenShareProfileSettings(voicePreferences.nativeScreenShareProfile).fps
    : screenQuality(voicePreferences.screenShareQuality).fps
  const localScreenPreviewActive = snapshot.screen.state === 'starting' ||
    snapshot.screen.state === 'running'
  const screenMedia = useRestartAwareMediaState(snapshot.screen.state)
  const cameraMedia = useRestartAwareMediaState(snapshot.camera.state)
  const localCameraActive = isLocalCameraPreviewActive(snapshot.camera)

  useEffect(() => {
    if (!desktop) return
    const fullscreen = stageFullscreen && focusedMediaId ===
      stageMediaItemId(auth.user?._id ?? '', 'screen')
    Effect.runFork(
      Effect.tryPromise({
        try: () =>
          desktop.media.setLocalScreenPreviewDemand({
            demanded:
              localScreenPreviewActive && localScreenPreviewConsumerCount > 0,
            width: fullscreen ? 1920 : 1280,
            height: fullscreen ? 1080 : 720,
            fps: localScreenPreviewFps,
          }),
        catch: (cause) => cause,
      }).pipe(Effect.ignore),
    )
  }, [
    desktop,
    auth.user?._id,
    focusedMediaId,
    localScreenPreviewFps,
    localScreenPreviewActive,
    localScreenPreviewConsumerCount,
    stageFullscreen,
  ])

  // Снимаем спрос на превью только при размонтировании. Если держать fps в
  // зависимостях, смена FPS стрима сначала выключала превью, а следующий
  // эффект тут же включал его снова — локальный стрим мигал.
  const localScreenPreviewFpsRef = useRef(localScreenPreviewFps)
  localScreenPreviewFpsRef.current = localScreenPreviewFps
  useEffect(() => {
    if (!desktop) return
    return () => {
      Effect.runFork(
        Effect.tryPromise({
          try: () =>
            desktop.media.setLocalScreenPreviewDemand({
              demanded: false,
              width: 1280,
              height: 720,
              fps: localScreenPreviewFpsRef.current,
            }),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
      )
    }
  }, [desktop])

  const inputDevices = useMediaDevices('audioinput')
  const videoDevices = useMediaDevices('videoinput')

  useEffect(() => {
    const client = desktop
      ? createDesktopVoiceClient(desktop)
      : createOwnedBrowserVoiceClient(
        auth.user?._id ?? 'signed-out',
        () => auth.user?._id ?? null,
      )
    watchedScreenViewerChannelsRef.current.clear()
    pendingScreenWatchIdsRef.current.clear()
    for (const timer of screenRepublishGraceTimersRef.current.values()) {
      clearTimeout(timer)
    }
    screenRepublishGraceTimersRef.current.clear()
    clientRef.current = client
    let previousSnapshot = client.snapshot()
    const mediaLiveness = createVoiceMediaLiveness(previousSnapshot)
    setSnapshot(previousSnapshot)
    setRoom(client.room())
    // Пересборка стрима/камеры при смене качества может провести медиа через
    // «выключено» на долю секунды. Звук остановки ждёт, и если медиа за это
    // время вернулось, не играют ни «остановлено», ни «запущено».
    const pendingStopSounds = new Map<string, ReturnType<typeof setTimeout>>()
    const playTransitionSound = (sound: SoundEventId) => {
      const [kind, phase] = sound.split('.')
      if (phase === 'stopped' && (kind === 'screen_share' || kind === 'camera')) {
        if (intentionalMediaStopRef.current[kind]) {
          intentionalMediaStopRef.current[kind] = false
          clearTimeout(pendingStopSounds.get(kind))
          pendingStopSounds.delete(kind)
          playUiSound(sound)
          return
        }
        const previousTimer = pendingStopSounds.get(kind)
        if (previousTimer) clearTimeout(previousTimer)
        pendingStopSounds.set(
          kind,
          setTimeout(() => {
            pendingStopSounds.delete(kind)
            playUiSound(sound)
          }, MEDIA_STOP_SOUND_GRACE_MS),
        )
        return
      }
      if (phase === 'started' && pendingStopSounds.has(kind)) {
        clearTimeout(pendingStopSounds.get(kind))
        pendingStopSounds.delete(kind)
        return
      }
      playUiSound(sound)
    }
    const unsubscribeSnapshot = client.subscribe((nextSnapshot) => {
      for (const sound of voiceSnapshotTransitionSounds(
        previousSnapshot,
        nextSnapshot,
        mediaLiveness,
      )) {
        playTransitionSound(sound)
      }
      previousSnapshot = nextSnapshot
      setSnapshot(nextSnapshot)
    })
    const unsubscribeRoom = client.subscribeRoom(setRoom)
    syncPreferences(client)

    return () => {
      unsubscribeSnapshot()
      for (const timer of pendingStopSounds.values()) clearTimeout(timer)
      pendingStopSounds.clear()
      unsubscribeRoom()
      if (clientRef.current === client) clientRef.current = null
      Effect.runFork(client.disposeEffect())
    }
  }, [auth.user?._id, desktop])

  useEffect(() => {
    let cameraProfile = readVoicePreferences().cameraProfile
    let nativeScreenShareProfile = readVoicePreferences().nativeScreenShareProfile
    return voicePreferenceStore.subscribe(() => {
      const client = clientRef.current
      if (client) syncPreferences(client)
      const preferences = readVoicePreferences()
      const screenProfileChanged =
        nativeScreenShareProfile !== preferences.nativeScreenShareProfile
      nativeScreenShareProfile = preferences.nativeScreenShareProfile
      if (desktop?.platform.os === 'win32' && screenProfileChanged) {
        client?.dispatch({
          type: 'setScreenProfile',
          ...nativeScreenShareProfileSettings(preferences.nativeScreenShareProfile),
        })
      }
      const profileChanged = cameraProfile !== preferences.cameraProfile
      cameraProfile = preferences.cameraProfile
      const cameraState = client?.snapshot().camera.state
      if (
        desktop?.platform.os === 'win32' &&
        profileChanged &&
        (cameraState === 'running' || cameraState === 'starting' || cameraState === 'failed')
      ) {
        client?.dispatch({
          type: 'setCamera',
          enabled: true,
          deviceId: preferences.preferredVideoDevice,
          profile: preferences.cameraProfile,
        })
      }
    })
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    const publish = () => {
      const client = clientRef.current
      if (!client) return
      client.dispatch({
        type: 'configureRemoteAudio',
        settings: voiceListenerStore.snapshot(++remoteAudioCommandRevision),
      })
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedulePublish = () => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        publish()
      }, REMOTE_AUDIO_PUBLISH_INTERVAL_MS)
    }
    publish()
    const unsubscribe = voiceListenerStore.subscribe(schedulePublish)
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    return desktop.media.onDisplayPickerResolved((selection) => {
      const preferences = readVoicePreferences()
      const quality = desktop.platform.os === 'win32'
        ? nativeScreenShareProfileSettings(preferences.nativeScreenShareProfile)
        : screenQuality(preferences.screenShareQuality)
      void dispatchVoice({
        type: 'setScreen',
        enabled: true,
        sourceId: selection.sourceId,
        audioEnabled: selection.audioRequested,
        audioMode: selection.audioMode,
        ...quality,
      })
    })
  }, [desktop])

  const speakingUserIds = useMemo(
    () => new Set(snapshot.speakingUserIds.map(baseVoiceIdentity).filter(Boolean)),
    [snapshot.speakingUserIds],
  )

  const cancelScreenRepublishGrace = useCallback((mediaId: string) => {
    const timer = screenRepublishGraceTimersRef.current.get(mediaId)
    if (timer) clearTimeout(timer)
    screenRepublishGraceTimersRef.current.delete(mediaId)
  }, [])

  const preserveScreenWatchDuringRepublish = useCallback(
    (mediaId: string) => {
      if (!watchedScreenViewerChannelsRef.current.has(mediaId)) return
      if (pendingScreenWatchIdsRef.current.has(mediaId)) return

      pendingScreenWatchIdsRef.current.add(mediaId)
      cancelScreenRepublishGrace(mediaId)
      const timer = setTimeout(() => {
        screenRepublishGraceTimersRef.current.delete(mediaId)
        if (!pendingScreenWatchIdsRef.current.delete(mediaId)) return
        watchedScreenViewerChannelsRef.current.delete(mediaId)
        setRoomRevision((revision) => revision + 1)
      }, 5_000)
      screenRepublishGraceTimersRef.current.set(mediaId, timer)
    },
    [cancelScreenRepublishGrace],
  )

  useEffect(() => {
    if (!room) return
    browserSubscriptionErrorsRef.current.clear()
    const refresh = () => setRoomRevision((revision) => revision + 1)
    const onTrackSubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
    ) => {
      browserSubscriptionErrorsRef.current.delete(publication.trackSid)
      refresh()
    }
    const onTrackSubscriptionFailed = (
      trackSid: string,
      _participant: RemoteParticipant,
      reason?: unknown,
    ) => {
      browserSubscriptionErrorsRef.current.set(
        trackSid,
        subscriptionFailureDetail(reason),
      )
      refresh()
    }
    const onTrackPublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      browserSubscriptionErrorsRef.current.delete(publication.trackSid)
      if (publication.source === Track.Source.ScreenShare) {
        const mediaId = stageMediaItemId(
          baseVoiceIdentity(participant.identity),
          'screen',
        )
        pendingScreenWatchIdsRef.current.delete(mediaId)
        cancelScreenRepublishGrace(mediaId)
      }
      refresh()
    }
    const onTrackUnpublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      browserSubscriptionErrorsRef.current.delete(publication.trackSid)
      if (publication.source === Track.Source.ScreenShare) {
        const mediaId = stageMediaItemId(
          baseVoiceIdentity(participant.identity),
          'screen',
        )
        preserveScreenWatchDuringRepublish(mediaId)
      }
      refresh()
    }
    room.on(RoomEvent.ParticipantConnected, refresh)
    room.on(RoomEvent.ParticipantDisconnected, refresh)
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, refresh)
    room.on(RoomEvent.TrackSubscriptionFailed, onTrackSubscriptionFailed)
    room.on(RoomEvent.TrackPublished, onTrackPublished)
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished)
    room.on(RoomEvent.TrackMuted, refresh)
    room.on(RoomEvent.TrackUnmuted, refresh)
    return () => {
      room.off(RoomEvent.ParticipantConnected, refresh)
      room.off(RoomEvent.ParticipantDisconnected, refresh)
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, refresh)
      room.off(RoomEvent.TrackSubscriptionFailed, onTrackSubscriptionFailed)
      room.off(RoomEvent.TrackPublished, onTrackPublished)
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished)
      room.off(RoomEvent.TrackMuted, refresh)
      room.off(RoomEvent.TrackUnmuted, refresh)
      for (const timer of screenRepublishGraceTimersRef.current.values()) {
        clearTimeout(timer)
      }
      screenRepublishGraceTimersRef.current.clear()
      pendingScreenWatchIdsRef.current.clear()
      browserSubscriptionErrorsRef.current.clear()
    }
  }, [cancelScreenRepublishGrace, preserveScreenWatchDuringRepublish, room])

  useEffect(() => {
    if (
      (snapshot.connection === 'disconnected' || snapshot.connection === 'failed') &&
      !snapshot.intentChannelId
    ) {
      watchedScreenViewerChannelsRef.current.clear()
      pendingScreenWatchIdsRef.current.clear()
      for (const timer of screenRepublishGraceTimersRef.current.values()) {
        clearTimeout(timer)
      }
      screenRepublishGraceTimersRef.current.clear()
    }
  }, [snapshot.connection, snapshot.intentChannelId])

  useEffect(() => {
    recordDiagnosticEvent('voice', 'session_snapshot', snapshot, {
      dedupeKey: 'voice.session_snapshot',
      heartbeatMs: 30_000,
    })
  }, [snapshot])

  useEffect(() => {
    const failureKey = snapshot.failure
      ? `${snapshot.failure.code}:${snapshot.operationId ?? ''}`
      : null
    if (failureKey && failureKey !== previousFailureRef.current) {
      toast.error(snapshot.failure?.message ?? 'Не удалось подключиться к голосу')
      // A native cause is already queued by main and leased by the renderer.
      // Keep its snapshot projection without enqueuing a second root report.
      if (auth.session?.token && snapshot.failure && !snapshot.failure.diagnosticCorrelationId) {
        enqueueAutomaticDiagnosticIncident({
          area: 'voice',
          severity: 'error',
          triggerCode: snapshot.failure.code,
          context: { snapshot, rtcHistory: diagnosticRtcHistoryRef.current },
        })
      }
    }
    previousFailureRef.current = failureKey
  }, [auth.session?.token, desktop, snapshot])

  useEffect(() => {
    const mediaFailure = ([
      ['microphone', snapshot.microphone.error],
      ['output', snapshot.output.error],
      ['camera', snapshot.camera.error],
      ['screen', snapshot.screen.error],
      ['screen_audio', snapshot.screenAudio.error],
    ] as const).find(([, error]) => Boolean(error))
    const error = mediaFailure?.[1]
    const failureKey = error
      ? `${mediaFailure?.[0]}:${error.code}:${snapshot.operationId ?? ''}`
      : null
    if (failureKey && failureKey !== previousMediaFailureRef.current) {
      // A fallback keeps media working on the default device: warn the user,
      // but it is not a failure worth an automatic report.
      const fallback = DEVICE_FALLBACK_WARNINGS[error?.code ?? '']
      if (fallback) {
        toast.warning(desktop ? fallback : error?.message ?? fallback)
      } else if (!desktop) {
        // Desktop path failures already have localized, actionable runtime banners.
        toast.error(error?.message ?? 'Медиа недоступно')
      }
      if (!fallback && auth.session?.token && error && mediaFailure && !error.diagnosticCorrelationId) {
        enqueueAutomaticDiagnosticIncident({
          area: mediaFailure[0] === 'screen_audio' ? 'screen' : mediaFailure[0],
          severity: 'error',
          triggerCode: error.code,
          context: { snapshot, rtcHistory: diagnosticRtcHistoryRef.current },
        })
      }
    }
    previousMediaFailureRef.current = failureKey
  }, [
    snapshot.camera.error,
    snapshot.microphone.error,
    snapshot.operationId,
    snapshot.output.error,
    snapshot.screen.error,
    snapshot.screenAudio.error,
    auth.session?.token,
    desktop,
    snapshot,
  ])

  const dispatchVoice = useCallback(async (command: VoiceCommand) => {
    const client = clientRef.current
    if (!client) throw new Error('Voice controller is not ready')
    client.dispatch(command)
  }, [])

  // join() sets the bitrate before connecting; this follows moderator moves
  // and channel setting changes during the call.
  const voiceChannelId = snapshot.intentChannelId ?? snapshot.membershipChannelId
  const microphoneBitrate = useSyncStore((state) => {
    const channel = voiceChannelId ? state.channels[voiceChannelId] : undefined
    return channel ? callAudioBitrateBps(channel) : null
  })
  useEffect(() => {
    if (microphoneBitrate === null) return
    clientRef.current?.dispatch({
      type: 'setMicrophoneBitrate',
      bitrate: microphoneBitrate,
    })
  }, [microphoneBitrate])

  const resetRemoteStageMedia = useCallback((targetChannelId: string | null) => {
    nativeVideoRegistry.clearRemote()
    let removedWatch = false
    for (const [mediaId, watchedChannelId] of
      watchedScreenViewerChannelsRef.current) {
      if (watchedChannelId === targetChannelId) continue
      cancelScreenRepublishGrace(mediaId)
      removedWatch =
        watchedScreenViewerChannelsRef.current.delete(mediaId) || removedWatch
      pendingScreenWatchIdsRef.current.delete(mediaId)
    }
    if (removedWatch) {
      setRoomRevision((revision) => revision + 1)
    }
  }, [cancelScreenRepublishGrace])

  const join = useCallback(
    async (channelId: string) => {
      const channel = syncStore.getState().channels[channelId]
      if (!canJoinVoiceChannel(channel)) {
        toast.error('Голос недоступен в этом канале')
        return false
      }
      try {
        const current = clientRef.current?.snapshot()
        if (current?.membershipChannelId !== channelId) {
          resetRemoteStageMedia(channelId)
        }
        const currentUserId = auth.user?._id
        const recipients =
          currentUserId &&
          (channel.channel_type === 'DirectMessage' ||
            channel.channel_type === 'Group')
            ? channel.recipients.filter((userId) => userId !== currentUserId)
            : undefined
        await dispatchVoice({
          type: 'setMicrophoneBitrate',
          bitrate: callAudioBitrateBps(channel),
        })
        await dispatchVoice({ type: 'join', channelId, recipients })
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Нет сессии')
        return false
      }
    },
    [auth.user?._id, dispatchVoice, resetRemoteStageMedia],
  )

  const leave = useCallback(() => {
    resetRemoteStageMedia(null)
    void dispatchVoice({ type: 'leave' })
  }, [dispatchVoice, resetRemoteStageMedia])

  const toggleMic = useCallback(() => {
    if (snapshot.userDeafened) {
      voicePreferenceStore.setDeafened(false)
      void dispatchVoice({ type: 'setUserDeafened', deafened: false })
      return
    }
    const enabled = snapshot.userMuted
    voicePreferenceStore.setMicEnabled(enabled)
    void dispatchVoice({ type: 'setUserMuted', muted: !enabled })
  }, [dispatchVoice, snapshot.userDeafened, snapshot.userMuted])

  const toggleDeafen = useCallback(() => {
    const deafened = !snapshot.userDeafened
    voicePreferenceStore.setDeafened(deafened)
    void dispatchVoice({ type: 'setUserDeafened', deafened })
  }, [dispatchVoice, snapshot.userDeafened])

  // The default camera is the first enumerated device, which may be a virtual
  // or busy one. A device failure asks the user to pick a camera explicitly.
  const cameraDeviceFailed = isCameraDeviceFailure(snapshot.camera)
  const [cameraDevicePickerRequest, setCameraDevicePickerRequest] = useState(0)
  const cameraDeviceFailedRef = useRef(false)
  useEffect(() => {
    if (cameraDeviceFailed && !cameraDeviceFailedRef.current) {
      setCameraDevicePickerRequest((request) => request + 1)
    }
    cameraDeviceFailedRef.current = cameraDeviceFailed
  }, [cameraDeviceFailed])

  const selectCameraDevice = useCallback((deviceId: string | undefined) => {
    voicePreferenceStore.setPreferredVideoDevice(deviceId)
    if (snapshot.camera.state === 'off') return
    intentionalMediaStopRef.current.camera = false
    // Picking the same device again restarts a failed camera in the director.
    void dispatchVoice({
      type: 'setCamera',
      enabled: true,
      deviceId,
      profile: readVoicePreferences().cameraProfile,
    })
  }, [dispatchVoice, snapshot.camera.state])

  const toggleCamera = useCallback(() => {
    const enabled = nextCameraEnabled(snapshot.camera)
    intentionalMediaStopRef.current.camera = !enabled
    if (!enabled) {
      eventsGateway.send({ type: 'VoiceMediaStopped', source: 'camera' })
    }
    void dispatchVoice({
      type: 'setCamera',
      enabled,
      deviceId: readVoicePreferences().preferredVideoDevice,
      profile: readVoicePreferences().cameraProfile,
    })
  }, [dispatchVoice, snapshot.camera])

  const openDesktopDisplayPicker = useCallback(() => {
    if (!desktop) return
    Effect.runFork(
      Effect.tryPromise({
        try: () =>
          desktop.media.openDisplayPicker(
            readVoicePreferences().screenShareAudio,
          ),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось открыть выбор демонстрации',
            )
          }),
        ),
      ),
    )
  }, [desktop])

  const toggleScreenShare = useCallback(() => {
    if (snapshot.screen.state === 'running' || snapshot.screen.state === 'starting') {
      intentionalMediaStopRef.current.screen_share = true
      eventsGateway.send({ type: 'VoiceMediaStopped', source: 'screen' })
      void dispatchVoice({ type: 'setScreen', enabled: false })
      return
    }
    intentionalMediaStopRef.current.screen_share = false
    if (desktop) {
      openDesktopDisplayPicker()
      return
    }
    const prefs = readVoicePreferences()
    void dispatchVoice({
      type: 'setScreen',
      enabled: true,
      audioEnabled: prefs.screenShareAudio,
      ...screenQuality(prefs.screenShareQuality),
    })
  }, [desktop, dispatchVoice, openDesktopDisplayPicker, snapshot.screen.state])

  const setSelfMonitoringActive = useCallback(
    (active: boolean) => {
      void dispatchVoice({ type: 'setSelfMonitoringActive', active })
    },
    [dispatchVoice],
  )

  const channelId =
    snapshot.connection === 'connected'
      ? snapshot.membershipChannelId
      : snapshot.connection === 'connecting' || snapshot.connection === 'recovering'
        ? snapshot.intentChannelId
        : null

  const presentation = useVoiceStagePresentation(channelId)
  const sessionStageMounted = presentation.mountedStageChannelIds.includes(
    channelId ?? '',
  )
  useEffect(() => {
    if (!sessionStageMounted && !presentation.popoutWindow)
      setStageFullscreen(false)
  }, [sessionStageMounted, presentation.popoutWindow])

  useEffect(() => {
    setActivityLauncherOpen(false)
  }, [channelId])

  useEffect(() => {
    if (!room || !channelId) return
    const watchedRemoteScreenIds = new Set(
      [...watchedScreenViewerChannelsRef.current]
        .filter(([, targetChannelId]) => targetChannelId === channelId)
        .map(([mediaId]) => mediaId),
    )
    const roomParticipants = [
      room.localParticipant,
      ...room.remoteParticipants.values(),
    ]
    for (const participant of roomParticipants) {
      const userId = baseVoiceIdentity(participant.identity)
      const subscribed = shouldSubscribeStageScreen({
        isLocal: participant === room.localParticipant,
        mediaId: stageMediaItemId(userId, 'screen'),
        watchedRemoteScreenIds,
      })
      for (const publication of participant.trackPublications.values()) {
        applyStageScreenPublicationSubscription(publication, subscribed)
      }
    }
  }, [channelId, room, roomRevision])

  // Fullscreen is scoped to one voice session and must not survive leave/move.
  useEffect(() => {
    setStageFullscreen(false)
  }, [channelId])

  const status = connectionStatus(snapshot)
  const connectionPhase = connectionPhaseFromSnapshot(snapshot)
  const participants = useSyncStore(
    (state) =>
      channelId
        ? getChannelVoiceParticipants(state, channelId, auth.user?._id)
        : [],
    sameVoiceParticipantList,
  )
  const micIssue = mediaIssue(snapshot)
  const mediaAvailability = useMemo<VoiceMediaAvailabilityState>(
    () =>
      buildVoiceMediaAvailabilityState({
        inputDevices,
        videoDevices,
        micIssue,
      }),
    [inputDevices, micIssue, videoDevices],
  )

  const viewedRemoteScreenIds = useMemo(
    () =>
      [...watchedScreenViewerChannelsRef.current]
        .filter(([, targetChannelId]) => targetChannelId === channelId)
        .map(([mediaId]) => mediaId),
    [channelId, roomRevision],
  )

  const watchedOwnerIds = useMemo(
    () =>
      normalizeWatchedOwnerIds(
        viewedRemoteScreenIds.flatMap(
          (mediaId) => stageScreenMediaUserId(mediaId) ?? [],
        ),
      ),
    [viewedRemoteScreenIds],
  )
  const serverWatchedOwnerIds = participants.find(
    (participant) => participant.id === auth.user?._id,
  )?.watching

  // The server holds who watches which stream, so every client derives the
  // same viewer lists. Resent until the echoed voice state matches.
  useEffect(() => {
    if (status !== 'connected' || !serverWatchedOwnerIds) return
    if (sameWatchedOwnerIds(serverWatchedOwnerIds, watchedOwnerIds)) return
    eventsGateway.sendReliable(
      { type: 'VoiceWatchUpdate', watching: watchedOwnerIds },
      'voice-watch',
    )
  }, [serverWatchedOwnerIds, status, watchedOwnerIds])

  const streamViewers = useMemo(
    () =>
      streamViewerSnapshot({
        channelId: status === 'connected' ? channelId : null,
        currentUserId: auth.user?._id ?? null,
        participants,
        watchedOwnerIds,
      }),
    [auth.user?._id, channelId, participants, status, watchedOwnerIds],
  )
  const previousStreamViewersRef = useRef<StreamViewerSnapshot | null>(null)
  useEffect(() => {
    const previous = previousStreamViewersRef.current
    previousStreamViewersRef.current = streamViewers
    if (!previous) return
    const sound = streamViewerTransitionSound(previous, streamViewers)
    if (sound) playUiSound(sound)
  }, [streamViewers])

  const builtStageMediaItems = useMemo(() => {
    const watchedRemoteScreenIds = new Set(viewedRemoteScreenIds)
    const items = buildStageItems({
      room: room
        ? createStageRoomFromLiveKit(
            room,
            browserSubscriptionErrorsRef.current,
          )
        : null,
      participants,
      currentUserId: auth.user?._id ?? null,
      filters: stageMediaFilters,
      watchedRemoteScreenIds,
      nativeTracks: nativeVideoTracks,
      nativePublications: nativeVideoPublications,
      localScreenPreview: desktop && localScreenPreviewActive && auth.user?._id
        ? {
          userId: auth.user._id,
          track: nativeVideoRegistry.getLocalScreenPreviewTrack(),
        }
        : null,
      localCameraActive,
      setNativeDemand: setNativeVideoDemand,
    })
    return withConnectingLocalAvatarItem(items, {
      connecting: status === 'connecting' && channelId != null,
      localUserId: auth.user?._id,
      filters: stageMediaFilters,
    })
  }, [
    auth.user?._id,
    channelId,
    desktop,
    participants,
    room,
    roomRevision,
    nativeVideoTracks,
    nativeVideoPublications,
    localCameraActive,
    localScreenPreviewActive,
    stageMediaFilters,
    status,
    setNativeVideoDemand,
    viewedRemoteScreenIds,
  ])
  // Своя трансляция пересобирается (смена качества): показываем загрузку на превью.
  const localScreenRestarting =
    screenMedia.live && snapshot.screen.state === 'starting'
  const stageMediaItems = useHeldRemoteScreenTracks(
    builtStageMediaItems,
    localScreenRestarting,
  )
  // Screen ownership and subscriptions are independent of the stage's display filters.
  const builtStreamMediaItems = useMemo(
    () =>
      buildStageItems({
        room: room
          ? createStageRoomFromLiveKit(
              room,
              browserSubscriptionErrorsRef.current,
            )
          : null,
        participants,
        currentUserId: auth.user?._id ?? null,
        filters: {
          showOwnStream: true,
          showRemoteStreams: true,
          showParticipantsWithoutMedia: false,
        },
        watchedRemoteScreenIds: new Set(viewedRemoteScreenIds),
        nativeTracks: nativeVideoTracks,
        nativePublications: nativeVideoPublications,
        localScreenPreview:
          desktop && localScreenPreviewActive && auth.user?._id
            ? {
                userId: auth.user._id,
                track: nativeVideoRegistry.getLocalScreenPreviewTrack(),
              }
            : null,
        localCameraActive,
        setNativeDemand: setNativeVideoDemand,
      }).filter((item) => item.kind === 'screen'),
    [
      room,
      roomRevision,
      participants,
      auth.user?._id,
      viewedRemoteScreenIds,
      nativeVideoTracks,
      nativeVideoPublications,
      desktop,
      localCameraActive,
      localScreenPreviewActive,
      setNativeVideoDemand,
    ],
  )
  const streamMediaItems = useHeldRemoteScreenTracks(
    builtStreamMediaItems,
    localScreenRestarting,
  )
  stageMediaItemsRef.current = [
    ...stageMediaItems,
    ...streamMediaItems.filter(
      (item) => !stageMediaItems.some((visible) => visible.id === item.id),
    ),
  ]
  const localPreviewTrack =
    streamMediaItems.find((item) => item.isLocal)?.track ?? null
  useStreamPreviewUpload(
    screenMedia.live ? channelId : null,
    auth.session?.token,
    localPreviewTrack,
  )

  useEffect(() => {
    if (!desktop) {
      nativeVideoDemandRef.current.clear()
      return
    }

    const activeDemandKeys = new Set<string>()
    for (const publication of nativeVideoPublications) {
      const demandKey = nativeVideoDemandKey(
        publication.sessionId,
        publication.generation,
        publication.demandTrackId,
      )
      activeDemandKeys.add(demandKey)

      const userId = baseVoiceIdentity(publication.participantIdentity)
      const demanded = publication.source === 'screen'
        ? Boolean(
            channelId && watchedScreenViewerChannelsRef.current.get(
              stageMediaItemId(userId, 'screen'),
            ) === channelId,
          )
        : stageMediaFilters.showRemoteStreams &&
          participants.some((participant) => participant.id === userId)
      if (nativeVideoDemandRef.current.get(demandKey) === demanded) continue
      setNativeVideoDemand(
        publication.sessionId,
        publication.generation,
        publication.demandTrackId,
        demanded,
      )
    }

    for (const demandKey of nativeVideoDemandRef.current.keys()) {
      if (!activeDemandKeys.has(demandKey)) {
        nativeVideoDemandRef.current.delete(demandKey)
      }
    }
  }, [
    channelId,
    desktop,
    nativeDemandRetryRevision,
    nativeVideoPublications,
    participants,
    roomRevision,
    setNativeVideoDemand,
    stageMediaFilters.showRemoteStreams,
  ])

  useEffect(() => () => {
    if (nativeDemandRetryTimerRef.current != null) {
      clearTimeout(nativeDemandRetryTimerRef.current)
      nativeDemandRetryTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!channelId) return
    const availableRemoteScreenIds = new Set(
      nativeVideoPublications
        .filter((publication) => publication.source === 'screen')
        .map((publication) =>
        stageMediaItemId(
          baseVoiceIdentity(publication.participantIdentity),
          'screen',
        )),
    )
    const remoteParticipantUserIds = new Set(
      participants
        .map(({ id }) => id)
        .filter((id) => id !== auth.user?._id),
    )
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        const userId = baseVoiceIdentity(participant.identity)
        remoteParticipantUserIds.add(userId)
        for (const publication of participant.trackPublications.values()) {
          if (publication.source === Track.Source.ScreenShare) {
            availableRemoteScreenIds.add(stageMediaItemId(userId, 'screen'))
          }
        }
      }
    }
    let removedWatch = false
    for (const [mediaId, targetChannelId] of watchedScreenViewerChannelsRef.current) {
      if (targetChannelId !== channelId) continue
      if (availableRemoteScreenIds.has(mediaId)) {
        pendingScreenWatchIdsRef.current.delete(mediaId)
        cancelScreenRepublishGrace(mediaId)
        continue
      }
      const userId = stageScreenMediaUserId(mediaId)
      if (userId && remoteParticipantUserIds.has(userId)) {
        preserveScreenWatchDuringRepublish(mediaId)
        continue
      }
      cancelScreenRepublishGrace(mediaId)
      removedWatch =
        watchedScreenViewerChannelsRef.current.delete(mediaId) || removedWatch
      pendingScreenWatchIdsRef.current.delete(mediaId)
    }
    if (removedWatch) {
      setRoomRevision((revision) => revision + 1)
    }
  }, [
    auth.user?._id,
    cancelScreenRepublishGrace,
    channelId,
    nativeVideoPublications,
    participants,
    preserveScreenWatchDuringRepublish,
    room,
    roomRevision,
  ])

  useEffect(() => {
    if (
      snapshot.connection !== 'connected' ||
      (!desktop && !room)
    ) {
      rtcDebugSnapshotRef.current = null
      diagnosticRtcHistoryRef.current = []
      rtcHealthMonitorRef.current.reset()
      setVoicePingMs(null)
      setVoicePingHistory([])
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    let rtcSampleFailureLogged = false
    const collectSample = desktop
      ? Effect.tryPromise({
          try: () => desktop.voice.getTelemetry(),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((telemetry) =>
            telemetry
              ? rtcDebugSnapshotFromTelemetry(
                  telemetry,
                  stageMediaItemsRef.current,
                )
              : null,
          ),
        )
      : collectVoiceRtcDebugSnapshotEffect(
          room!,
          stageMediaItemsRef.current,
        ).pipe(Effect.map((current) => current as RtcDebugSnapshot | null))
    const sample = collectSample.pipe(
      Effect.tap((current) =>
        Effect.sync(() => {
          if (!current) return
          const previous = rtcDebugSnapshotRef.current
          if (previous && current.timestamp <= previous.timestamp) return
          const next = attachRtcRatesToScreenShares(
            previous
              ? { ...current, rates: deriveRtcRates(previous, current) }
              : current,
          )
          rtcDebugSnapshotRef.current = next
          const pingMs = next.transport.pingMs ?? null
          setVoicePingMs(pingMs)
          if (pingMs != null) {
            setVoicePingHistory((history) =>
              appendVoicePingSample(history, {
                timestamp: next.timestamp,
                ms: pingMs,
              }),
            )
          }
          diagnosticRtcHistoryRef.current = appendRtcDebugSample(
            diagnosticRtcHistoryRef.current,
            next,
          )
          recordDiagnosticEvent('rtc', 'sample', next)
          const health = rtcHealthMonitorRef.current.observe(next)
          for (const incident of health.incidents) {
            recordDiagnosticEvent('rtc', 'health_incident', {
              triggerCode: incident.triggerCode,
              ...incident.context,
            })
            if (auth.session?.token) {
              enqueueAutomaticDiagnosticIncident(incident)
            }
          }
          for (const triggerCode of health.recovered) {
            recordDiagnosticEvent('rtc', 'health_recovered', { triggerCode })
          }
          setRtcDebugSnapshot(next)
          if (rtcDebugEnabled) {
            setRtcDebugHistory((history) => appendRtcDebugSample(history, next))
          }
        }),
      ),
      // A failing sample must not stop the poller, but it must not be silent:
      // a contract mismatch here once left every network panel empty.
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (rtcSampleFailureLogged) return
          rtcSampleFailureLogged = true
          console.warn('[voice] RTC telemetry sample failed', cause)
        }),
      ),
    )
    const fiber = Effect.runFork(
      sample.pipe(
        Effect.repeat(
          Schedule.spaced(rtcDebugEnabled ? 1_000 : 2_000),
        ),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [auth.session?.token, desktop, room, rtcDebugEnabled, snapshot.connection])

  const setStageMediaFilters = useCallback<
    VoiceStageContextValue['setStageMediaFilters']
  >((next) => {
    setStageMediaFiltersState((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      writeStageMediaFilters(value)
      return value
    })
  }, [])

  const setFocusedMediaId = useCallback(
    (mediaId: string | null) => {
      const item = stageMediaItemsRef.current.find(
        (candidate) => candidate.id === mediaId,
      )
      if (item?.kind === 'screen') {
        setStageMediaFilters((filters) => {
          if (item.isLocal ? filters.showOwnStream : filters.showRemoteStreams)
            return filters
          return item.isLocal
            ? { ...filters, showOwnStream: true }
            : { ...filters, showRemoteStreams: true }
        })
      }
      setFocusedMediaIdState(mediaId)
      if (mediaId) setStageFocusNonce((nonce) => nonce + 1)
    },
    [setStageMediaFilters],
  )

  const watchParticipantScreenShare = useCallback(
    async (targetChannelId: string, userId: string) => {
      const mediaId = stageMediaItemId(userId, 'screen')
      watchedScreenViewerChannelsRef.current.set(mediaId, targetChannelId)
      pendingScreenWatchIdsRef.current.add(mediaId)
      setRoomRevision((revision) => revision + 1)
      if (channelId !== targetChannelId || status !== 'connected') {
        const joined = await join(targetChannelId)
        if (!joined) {
          watchedScreenViewerChannelsRef.current.delete(mediaId)
          pendingScreenWatchIdsRef.current.delete(mediaId)
          setRoomRevision((revision) => revision + 1)
          return
        }
      }
      setFocusedMediaId(mediaId)
    },
    [channelId, join, setFocusedMediaId, status],
  )

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const item = stageMediaItemsRef.current.find(
        (candidate) => candidate.id === mediaId,
      )
      const screenUserId = stageScreenMediaUserId(mediaId)
      if (item?.kind === 'screen') {
        const action = setStageScreenSubscription(item, subscribed)
        if (action === 'stop-local-screen') {
          void dispatchVoice({ type: 'setScreen', enabled: false })
        } else if (!item.isLocal) {
          if (subscribed && channelId) {
            watchedScreenViewerChannelsRef.current.set(item.id, channelId)
            pendingScreenWatchIdsRef.current.delete(item.id)
            cancelScreenRepublishGrace(item.id)
          } else if (!subscribed) {
            cancelScreenRepublishGrace(item.id)
            watchedScreenViewerChannelsRef.current.delete(item.id)
            pendingScreenWatchIdsRef.current.delete(item.id)
          }
        }
      } else if (screenUserId) {
        if (subscribed && channelId) {
          watchedScreenViewerChannelsRef.current.set(mediaId, channelId)
          pendingScreenWatchIdsRef.current.delete(mediaId)
        } else if (!subscribed) {
          cancelScreenRepublishGrace(mediaId)
          watchedScreenViewerChannelsRef.current.delete(mediaId)
          pendingScreenWatchIdsRef.current.delete(mediaId)
        }
      } else {
        setVoiceStageMediaPublicationSubscribed(
          item?.publication,
          subscribed,
        )
      }
      setRoomRevision((revision) => revision + 1)
    },
    [cancelScreenRepublishGrace, channelId, dispatchVoice],
  )

  const sessionValue = useMemo<VoiceSessionContextValue>(
    () => ({
      channelId,
      status,
      connectionPhase,
      localVoiceReady: snapshot.connection === 'connected',
      micEnabled: !snapshot.userMuted,
      micPublishing: snapshot.microphone.state === 'running',
      deafened: snapshot.userDeafened || snapshot.serverDeafened,
      participantCount: participants.length,
      speakingUserIds,
      join,
      leave,
      toggleMic,
      toggleDeafen,
    }),
    [
      channelId,
      connectionPhase,
      join,
      leave,
      participants.length,
      snapshot,
      speakingUserIds,
      status,
      toggleDeafen,
      toggleMic,
    ],
  )

  const mediaValue = useMemo<VoiceMediaContextValue>(
    () => ({
      micIssue,
      mediaAvailability,
      cameraEnabled: cameraMedia.live,
      cameraDeviceFailed,
      cameraDevicePickerRequest,
      screenShareEnabled: screenMedia.live,
      screenShareStarting: screenMedia.starting,
      toggleCamera,
      selectCameraDevice,
      toggleScreenShare,
      changeScreenShareSource: desktop ? openDesktopDisplayPicker : undefined,
      setSelfMonitoringActive,
      getNativeMicrophonePreviewTrack: () => null,
    }),
    [
      desktop,
      openDesktopDisplayPicker,
      mediaAvailability,
      micIssue,
      setSelfMonitoringActive,
      cameraMedia.live,
      cameraDeviceFailed,
      cameraDevicePickerRequest,
      screenMedia.live,
      screenMedia.starting,
      selectCameraDevice,
      toggleCamera,
      toggleScreenShare,
    ],
  )

  const stageValue = useMemo<VoiceStageContextValue>(
    () => ({
      stageChannelId: channelId,
      stageMediaItems,
      streamMediaItems,
      ...presentation,
      viewedRemoteScreenIds,
      focusedMediaId,
      setFocusedMediaId,
      stageFocusNonce,
      watchParticipantScreenShare,
      stageMediaFilters,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFullscreen,
      toggleStageFullscreen: () => setStageFullscreen((value) => !value),
      activityLauncherOpen,
      setActivityLauncherOpen,
    }),
    [
      activityLauncherOpen,
      channelId,
      focusedMediaId,
      setFocusedMediaId,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFocusNonce,
      stageFullscreen,
      stageMediaFilters,
      stageMediaItems,
      streamMediaItems,
      presentation,
      viewedRemoteScreenIds,
      watchParticipantScreenShare,
    ],
  )

  const telemetryValue = useMemo<VoiceTelemetryContextValue>(
    () => ({
      voicePingMs,
      voicePingHistory,
      rtcDebugEnabled,
      setRtcDebugEnabled,
      rtcDebugSnapshot,
      rtcDebugHistory,
    }),
    [
      rtcDebugEnabled,
      rtcDebugHistory,
      rtcDebugSnapshot,
      voicePingHistory,
      voicePingMs,
    ],
  )

  return (
    <VoiceSessionContext.Provider value={sessionValue}>
      <VoiceMediaContext.Provider value={mediaValue}>
        <VoiceStageContext.Provider value={stageValue}>
          <VoiceTelemetryContext.Provider value={telemetryValue}>
            {children}
            {desktop ? <DesktopScreenSharePicker /> : null}
          </VoiceTelemetryContext.Provider>
        </VoiceStageContext.Provider>
      </VoiceMediaContext.Provider>
    </VoiceSessionContext.Provider>
  )
}

function createOwnedBrowserVoiceClient(
  userId: string,
  getCurrentUserId: () => string | null,
): VoiceClient {
  return new VoiceTabOwner(userId, INITIAL_SNAPSHOT, () =>
    createBrowserVoiceClient(getCurrentUserId),
  )
}

function createBrowserVoiceClient(getCurrentUserId: () => string | null): VoiceClient {
  const authority = createWebVoiceAuthorityAdapter(getCurrentUserId)
  const engine = new BrowserRtcEngineAdapter()
  const director = new VoiceDirector({
    authority,
    engine,
    rtcEngine: 'web',
    clientInstanceId: `web-${crypto.randomUUID()}`,
  })
  const disposeEffect = Effect.fn('voice.disposeBrowserVoiceClient')(
    function*() {
      yield* director.disposeEffect()
      yield* engine.disposeEffect()
      authority.dispose()
    },
  )
  return {
    dispatch: (command) => director.dispatch(command),
    snapshot: () => director.snapshot(),
    subscribe: (listener) => director.subscribe(listener),
    room: () => engine.room(),
    subscribeRoom: (listener) => engine.subscribeRoom(listener),
    dispose() {
      return Effect.runPromise(disposeEffect())
    },
    disposeEffect,
  }
}

function createDesktopVoiceClient(
  desktop: NonNullable<ReturnType<typeof getSyrnikeDesktop>>,
): VoiceClient {
  let snapshot = INITIAL_SNAPSHOT
  const listeners = new Set<(value: VoiceSnapshot) => void>()
  let pushedSnapshotRevision = 0
  const unsubscribe = desktop.voice.onSnapshot((next) => {
    pushedSnapshotRevision += 1
    snapshot = next
    for (const listener of listeners) listener(next)
  })
  const initialSnapshotRevision = pushedSnapshotRevision
  const initialSnapshotFiber = Effect.runFork(
    Effect.tryPromise({
      try: () => desktop.voice.getSnapshot(),
      catch: (cause) => cause,
    }).pipe(
      Effect.tap((next) =>
        Effect.sync(() => {
          if (pushedSnapshotRevision !== initialSnapshotRevision) return
          snapshot = next
          for (const listener of listeners) listener(next)
        }),
      ),
      Effect.ignore,
    ),
  )
  const disposeEffect = () =>
    Effect.sync(() => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(initialSnapshotFiber))
      listeners.clear()
    })
  return {
    dispatch(command) {
      Effect.runFork(
        Effect.tryPromise({
          try: () => desktop.voice.dispatch(command),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Native voice command failed',
              )
            }),
          ),
        ),
      )
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
    room: () => null,
    subscribeRoom(listener) {
      listener(null)
      return () => undefined
    },
    dispose() {
      Effect.runSync(disposeEffect())
    },
    disposeEffect,
  }
}

function syncPreferences(client: VoiceClient) {
  const preferences = readVoicePreferences()
  client.dispatch({ type: 'setUserMuted', muted: !preferences.micEnabled })
  client.dispatch({ type: 'setUserDeafened', deafened: preferences.deafened })
  client.dispatch({
    type: 'configureMicrophone',
    deviceId: preferences.preferredAudioInputDevice,
    bypassSystemAudioInputProcessing:
      preferences.bypassSystemAudioInputProcessing,
    automaticGainControl: preferences.automaticGainControl,
    noiseSuppression: preferences.noiseSuppression,
    echoCancellation: preferences.echoCancellation,
    inputVolume: preferences.inputVolume,
    voiceGateEnabled: preferences.voiceGateEnabled,
    voiceGateThresholdDb: preferences.voiceGateThresholdDb,
    voiceGateAutoThreshold: preferences.voiceGateAutoThreshold,
  })
  client.dispatch({
    type: 'configureOutput',
    deviceId: preferences.preferredAudioOutputDevice,
    volume: preferences.outputVolume,
  })
}

function connectionStatus(snapshot: VoiceSnapshot): VoiceStatus {
  if (snapshot.connection === 'connected') return 'connected'
  if (snapshot.connection === 'connecting' || snapshot.connection === 'recovering') {
    return 'connecting'
  }
  return 'idle'
}

function connectionPhaseFromSnapshot(
  snapshot: VoiceSnapshot,
): VoiceConnectionPhase {
  switch (snapshot.connection) {
    case 'connected':
      return 'connected'
    case 'recovering':
      return 'reconnecting'
    case 'failed':
      return 'failed'
    case 'connecting':
      return 'connecting_rtc'
    default:
      return 'idle'
  }
}

function mediaIssue(snapshot: VoiceSnapshot): VoiceMicIssue | null {
  const error = snapshot.microphone.error
  if (!error) return null
  return {
    label: 'Микрофон недоступен',
    hint: error.message,
    retryable: error.retryable,
  }
}

function nativeVideoDemandKey(
  sessionId: string,
  generation: number,
  trackId: string,
) {
  return [sessionId, generation, trackId].join('\u0000')
}

function screenQuality(quality: string) {
  switch (quality) {
    case 'high60':
      return {
        width: 1_920,
        height: 1_080,
        fps: 60,
        bitrate: 10_000_000,
        audioBitrate: 128_000,
      }
    case 'low':
      return {
        width: 1_280,
        height: 720,
        fps: 30,
        bitrate: 3_000_000,
        audioBitrate: 96_000,
      }
    case 'text':
      return {
        width: 1_920,
        height: 1_080,
        fps: 30,
        bitrate: 8_000_000,
        audioBitrate: 96_000,
      }
    default:
      return {
        width: 1_920,
        height: 1_080,
        fps: 30,
        bitrate: 6_000_000,
        audioBitrate: 128_000,
      }
  }
}

function subscriptionFailureDetail(reason: unknown) {
  if (reason == null) return ''
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Смена разрешения/FPS пересобирает публикацию: движок проводит уже идущий
 * стрим через `running → starting → running`. Для интерфейса это не выключение
 * и не новый запуск — плашка трансляции, кнопки и превью не должны мигать.
 */
function useRestartAwareMediaState(state: VoiceMediaState) {
  const wasLiveRef = useRef(false)
  if (state === 'running') wasLiveRef.current = true
  else if (state !== 'starting') wasLiveRef.current = false
  const restarting = state === 'starting' && wasLiveRef.current
  return {
    live: state === 'running' || restarting,
    starting: state === 'starting' && !restarting,
  }
}

/** How long a watched remote stream may lack its track while it republishes. */
const REMOTE_SCREEN_TRACK_HOLD_MS = 3_000

/**
 * A quality change republishes the streamer's screen track: for a moment the
 * watched item has no track, then a new one. Keep showing the last track (its
 * last frame) for that gap instead of flashing the «connecting» placeholder.
 * A stream that really stops disappears from the list and is not held.
 */
function useHeldRemoteScreenTracks(
  items: VoiceStageMediaItem[],
  localScreenRestarting: boolean,
): VoiceStageMediaItem[] {
  const heldRef = useRef(
    new Map<string, { track: VoiceStageMediaTrack; missingSince: number | null }>(),
  )
  const [expiryTick, setExpiryTick] = useState(0)
  const { result, nextExpiry } = useMemo(() => {
    const now = Date.now()
    const held = heldRef.current
    const present = new Set<string>()
    let nextExpiry: number | null = null
    const result = items.map((item) => {
      if (item.kind === 'screen' && item.isLocal) {
        return localScreenRestarting && item.track
          ? { ...item, track: { ...item.track, reconnecting: true } }
          : item
      }
      if (item.kind !== 'screen') return item
      present.add(item.id)
      if (item.track) {
        held.set(item.id, { track: item.track, missingSince: null })
        return item
      }
      const entry = held.get(item.id)
      if (!entry || item.subscribed === false || item.error) {
        held.delete(item.id)
        return item
      }
      entry.missingSince ??= now
      const expiresAt = entry.missingSince + REMOTE_SCREEN_TRACK_HOLD_MS
      if (now >= expiresAt) {
        held.delete(item.id)
        return item
      }
      nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt)
      return {
        ...item,
        track: { ...entry.track, reconnecting: true },
        live: true,
      }
    })
    for (const id of [...held.keys()]) if (!present.has(id)) held.delete(id)
    return { result, nextExpiry }
    // expiryTick re-evaluates held tracks once their grace runs out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, localScreenRestarting, expiryTick])
  useEffect(() => {
    if (nextExpiry === null) return
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, nextExpiry - Date.now()) + 10,
    )
    return () => clearTimeout(timer)
  }, [nextExpiry])
  return result
}
