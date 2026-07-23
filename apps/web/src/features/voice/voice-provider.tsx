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
  type RemoteTrackPublication,
} from 'livekit-client'
import {
  VoiceDirector,
  createInactiveMediaSnapshot,
  type VoiceCommand,
  type VoiceSnapshot,
} from '@syrnike13/platform'
import { toast } from 'sonner'

import { useAuth } from '#/features/auth/auth-context'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { getChannelVoiceParticipants } from '#/features/sync/voice-selectors'
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
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { useVoicePreferences } from '#/features/voice/use-voice-preferences'
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
import type {
  VoiceStageMediaItem,
} from '#/features/voice/voice-context'
import { buildStageItems } from '#/features/voice/voice-stage-items'
import { withConnectingLocalAvatarItem } from '#/features/voice/voice-connecting-preview'
import {
  attachRtcRatesToScreenShares,
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  type RtcDebugSnapshot,
  type RtcDebugStageMediaItem,
} from '#/features/voice/voice-rtc-debug'
import { playUiSound } from '#/features/sounds/sound-player'
import {
  SCREEN_VIEWER_SOUND_TOPIC,
  createScreenViewerSoundPayload,
  screenViewerSoundEventFromData,
  screenViewerWatchNotification,
} from '#/features/voice/voice-screen-viewer-sounds'
import { voiceSnapshotTransitionSounds } from '#/features/voice/voice-transition-sounds'
import { getSyrnikeDesktop } from '#/platform/runtime'
import { recordDiagnosticEvent } from '#/features/diagnostics/diagnostic-reporter'
import { enqueueAutomaticDiagnosticIncident } from '#/features/diagnostics/automatic-diagnostic-incidents'

type VoiceClient = {
  dispatch(command: VoiceCommand): void
  snapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
  room(): Room | null
  subscribeRoom(listener: (room: Room | null) => void): () => void
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

let remoteAudioCommandRevision = 0

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
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
  const diagnosticRtcHistoryRef = useRef<RtcDebugSnapshot[]>([])
  const stalledLocalScreenSamplesRef = useRef(0)
  const stalledRemoteScreenSamplesRef = useRef(0)
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const watchedScreenViewerChannelsRef = useRef(new Map<string, string>())
  const pendingScreenWatchIdsRef = useRef(new Set<string>())
  const screenRepublishGraceTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  )
  const nativeScreenDemandRef = useRef(new Map<string, boolean>())
  const nativeDemandRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setNativeScreenDemand = useCallback((
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) => {
    if (!desktop) return
    const demandKey = nativeScreenDemandKey(sessionId, generation, trackId)
    nativeScreenDemandRef.current.set(demandKey, demanded)
    if (demanded) {
      nativeVideoRegistry.beginSubscriptionRetry(sessionId, generation, trackId)
    }
    void desktop.media.setRemoteVideoDemand(
      sessionId,
      generation,
      trackId,
      demanded,
    ).catch(() => {
      if (nativeScreenDemandRef.current.get(demandKey) === demanded) {
        nativeScreenDemandRef.current.delete(demandKey)
      }
      if (nativeDemandRetryTimerRef.current == null) {
        nativeDemandRetryTimerRef.current = setTimeout(() => {
          nativeDemandRetryTimerRef.current = null
          setNativeDemandRetryRevision((revision) => revision + 1)
        }, 250)
      }
    })
  }, [desktop])
  const notifiedScreenViewerIdsRef = useRef(new Set<string>())
  const previousFailureRef = useRef<string | null>(null)
  const previousMediaFailureRef = useRef<string | null>(null)
  const voicePreferences = useVoicePreferences()
  const localScreenPreviewFps = screenQuality(
    voicePreferences.screenShareQuality,
  ).fps
  const localScreenPreviewActive = snapshot.screen.state === 'starting' ||
    snapshot.screen.state === 'running'

  useEffect(() => {
    if (!desktop) return
    const fullscreen = stageFullscreen && focusedMediaId ===
      stageMediaItemId(auth.user?._id ?? '', 'screen')
    void desktop.media.setLocalScreenPreviewDemand({
      demanded: localScreenPreviewActive && localScreenPreviewConsumerCount > 0,
      width: fullscreen ? 1920 : 1280,
      height: fullscreen ? 1080 : 720,
      fps: localScreenPreviewFps,
    }).catch(() => undefined)
  }, [
    desktop,
    auth.user?._id,
    focusedMediaId,
    localScreenPreviewFps,
    localScreenPreviewActive,
    localScreenPreviewConsumerCount,
    stageFullscreen,
  ])

  useEffect(() => {
    if (!desktop) return
    return () => {
      void desktop.media.setLocalScreenPreviewDemand({
        demanded: false,
        width: 1280,
        height: 720,
        fps: localScreenPreviewFps,
      }).catch(() => undefined)
    }
  }, [desktop, localScreenPreviewFps])

  const inputDevices = useMediaDevices('audioinput')
  const videoDevices = useMediaDevices('videoinput')

  useEffect(() => {
    const client = desktop
      ? createDesktopVoiceClient(desktop)
      : isElectronRenderer()
        ? createDesktopBridgeUnavailableVoiceClient()
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
    setSnapshot(previousSnapshot)
    setRoom(client.room())
    const unsubscribeSnapshot = client.subscribe((nextSnapshot) => {
      for (const sound of voiceSnapshotTransitionSounds(
        previousSnapshot,
        nextSnapshot,
      )) {
        playUiSound(sound)
      }
      previousSnapshot = nextSnapshot
      setSnapshot(nextSnapshot)
    })
    const unsubscribeRoom = client.subscribeRoom(setRoom)
    syncPreferences(client)

    return () => {
      unsubscribeSnapshot()
      unsubscribeRoom()
      if (clientRef.current === client) clientRef.current = null
      void client.dispose()
    }
  }, [auth.user?._id, desktop])

  useEffect(() => {
    return voicePreferenceStore.subscribe(() => {
      const client = clientRef.current
      if (client) syncPreferences(client)
    })
  }, [])

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
    publish()
    return voiceListenerStore.subscribe(publish)
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    return desktop.media.onDisplayPickerResolved((selection) => {
      const quality = screenQuality(readVoicePreferences().screenShareQuality)
      void dispatchVoice({
        type: 'setScreen',
        enabled: true,
        sourceId: selection.sourceId,
        audioEnabled: selection.audioRequested,
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
        notifiedScreenViewerIdsRef.current.delete(mediaId)
        setRoomRevision((revision) => revision + 1)
      }, 5_000)
      screenRepublishGraceTimersRef.current.set(mediaId, timer)
    },
    [cancelScreenRepublishGrace],
  )

  useEffect(() => {
    if (!room) return
    const refresh = () => setRoomRevision((revision) => revision + 1)
    const onTrackPublished = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
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
    room.on(RoomEvent.TrackSubscribed, refresh)
    room.on(RoomEvent.TrackUnsubscribed, refresh)
    room.on(RoomEvent.TrackSubscriptionFailed, refresh)
    room.on(RoomEvent.TrackPublished, onTrackPublished)
    room.on(RoomEvent.TrackUnpublished, onTrackUnpublished)
    room.on(RoomEvent.TrackMuted, refresh)
    room.on(RoomEvent.TrackUnmuted, refresh)
    return () => {
      room.off(RoomEvent.ParticipantConnected, refresh)
      room.off(RoomEvent.ParticipantDisconnected, refresh)
      room.off(RoomEvent.TrackSubscribed, refresh)
      room.off(RoomEvent.TrackUnsubscribed, refresh)
      room.off(RoomEvent.TrackSubscriptionFailed, refresh)
      room.off(RoomEvent.TrackPublished, onTrackPublished)
      room.off(RoomEvent.TrackUnpublished, onTrackUnpublished)
      room.off(RoomEvent.TrackMuted, refresh)
      room.off(RoomEvent.TrackUnmuted, refresh)
      for (const timer of screenRepublishGraceTimersRef.current.values()) {
        clearTimeout(timer)
      }
      screenRepublishGraceTimersRef.current.clear()
      pendingScreenWatchIdsRef.current.clear()
    }
  }, [cancelScreenRepublishGrace, preserveScreenWatchDuringRepublish, room])

  const publishScreenViewerSound = useCallback(
    (activeRoom: Room, screenOwnerId: string, action: 'join' | 'leave') => {
      const owner = Array.from(activeRoom.remoteParticipants.values()).find(
        (participant) => baseVoiceIdentity(participant.identity) === screenOwnerId,
      )
      if (!owner) return false
      void activeRoom.localParticipant
        .publishData(createScreenViewerSoundPayload({ action, screenOwnerId }), {
          reliable: true,
          destinationIdentities: [owner.identity],
          topic: SCREEN_VIEWER_SOUND_TOPIC,
        })
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn('Failed to publish screen viewer sound intent', error)
          }
        })
      return true
    },
    [],
  )

  const updateScreenViewerNotification = useCallback(
    (
      activeRoom: Room,
      mediaId: string,
      screenOwnerId: string,
      subscribed: boolean,
    ) => {
      const watched = notifiedScreenViewerIdsRef.current
      const action = screenViewerWatchNotification({
        isLocal:
          screenOwnerId === auth.user?._id ||
          screenOwnerId === baseVoiceIdentity(activeRoom.localParticipant.identity),
        wasWatching: watched.has(mediaId),
        subscribed,
      })
      if (!action) return
      const published = publishScreenViewerSound(
        activeRoom,
        screenOwnerId,
        action,
      )
      if (subscribed && published) watched.add(mediaId)
      if (!subscribed) watched.delete(mediaId)
    },
    [auth.user?._id, publishScreenViewerSound],
  )

  useEffect(() => {
    if (!room) return
    const onDataReceived = (
      payload: Uint8Array,
      participant?: { identity: string },
      _kind?: unknown,
      topic?: string,
    ) => {
      const sound = screenViewerSoundEventFromData({
        payload,
        topic,
        senderIdentity: participant?.identity,
        currentUserId: auth.user?._id,
      })
      if (sound) playUiSound(sound)
    }
    room.on(RoomEvent.DataReceived, onDataReceived)
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived)
      for (const mediaId of notifiedScreenViewerIdsRef.current) {
        const screenOwnerId = stageScreenMediaUserId(mediaId)
        if (screenOwnerId) {
          publishScreenViewerSound(room, screenOwnerId, 'leave')
        }
      }
      notifiedScreenViewerIdsRef.current.clear()
    }
  }, [auth.user?._id, publishScreenViewerSound, room])

  useEffect(() => {
    if (!room || snapshot.connection !== 'connected') return
    for (const [mediaId, targetChannelId] of watchedScreenViewerChannelsRef.current) {
      if (targetChannelId !== snapshot.membershipChannelId) continue
      const screenOwnerId = stageScreenMediaUserId(mediaId)
      if (screenOwnerId) {
        updateScreenViewerNotification(room, mediaId, screenOwnerId, true)
      }
    }
  }, [room, roomRevision, snapshot, updateScreenViewerNotification])

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
      if (auth.session?.token && snapshot.failure) {
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
      if (error?.code === 'output_device_fallback') {
        toast.warning(error.message)
      } else {
        toast.error(error?.message ?? 'Медиа недоступно')
      }
      if (auth.session?.token && error && mediaFailure) {
        enqueueAutomaticDiagnosticIncident({
          area: mediaFailure[0] === 'screen_audio' ? 'screen' : mediaFailure[0],
          severity: error.code === 'output_device_fallback' ? 'warning' : 'error',
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
      notifiedScreenViewerIdsRef.current.delete(mediaId)
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

  const toggleCamera = useCallback(() => {
    const enabled =
      snapshot.camera.state === 'off' || snapshot.camera.state === 'failed'
    void dispatchVoice({
      type: 'setCamera',
      enabled,
      deviceId: readVoicePreferences().preferredVideoDevice,
    })
  }, [dispatchVoice, snapshot.camera.state])

  const toggleScreenShare = useCallback(() => {
    if (snapshot.screen.state === 'running' || snapshot.screen.state === 'starting') {
      void dispatchVoice({ type: 'setScreen', enabled: false })
      return
    }
    if (desktop) {
      void desktop.media
        .openDisplayPicker(readVoicePreferences().screenShareAudio)
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось открыть выбор демонстрации',
          )
        })
      return
    }
    const prefs = readVoicePreferences()
    void dispatchVoice({
      type: 'setScreen',
      enabled: true,
      audioEnabled: prefs.screenShareAudio,
      ...screenQuality(prefs.screenShareQuality),
    })
  }, [desktop, dispatchVoice, snapshot.screen.state])

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
  const participants = useSyncStore((state) =>
    channelId
      ? getChannelVoiceParticipants(state, channelId, auth.user?._id)
      : [],
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

  const stageMediaItems = useMemo(() => {
    const watchedRemoteScreenIds = new Set(viewedRemoteScreenIds)
    const items = buildStageItems({
      room,
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
      setNativeDemand: setNativeScreenDemand,
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
    localScreenPreviewActive,
    stageMediaFilters,
    status,
    setNativeScreenDemand,
    viewedRemoteScreenIds,
  ])
  stageMediaItemsRef.current = stageMediaItems

  useEffect(() => {
    if (!desktop) {
      nativeScreenDemandRef.current.clear()
      return
    }

    const activeDemandKeys = new Set<string>()
    for (const publication of nativeVideoPublications) {
      const demandKey = nativeScreenDemandKey(
        publication.sessionId,
        publication.generation,
        publication.demandTrackId,
      )
      activeDemandKeys.add(demandKey)

      const mediaId = stageMediaItemId(
        baseVoiceIdentity(publication.participantIdentity),
        'screen',
      )
      const demanded = Boolean(
        channelId &&
          watchedScreenViewerChannelsRef.current.get(mediaId) === channelId,
      )
      if (nativeScreenDemandRef.current.get(demandKey) === demanded) continue
      setNativeScreenDemand(
        publication.sessionId,
        publication.generation,
        publication.demandTrackId,
        demanded,
      )
    }

    for (const demandKey of nativeScreenDemandRef.current.keys()) {
      if (!activeDemandKeys.has(demandKey)) {
        nativeScreenDemandRef.current.delete(demandKey)
      }
    }
  }, [
    channelId,
    desktop,
    nativeDemandRetryRevision,
    nativeVideoPublications,
    roomRevision,
    setNativeScreenDemand,
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
      nativeVideoPublications.map((publication) =>
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
      notifiedScreenViewerIdsRef.current.delete(mediaId)
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
    if (snapshot.connection !== 'connected' || !room) {
      rtcDebugSnapshotRef.current = null
      diagnosticRtcHistoryRef.current = []
      stalledLocalScreenSamplesRef.current = 0
      stalledRemoteScreenSamplesRef.current = 0
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    let active = true
    let sampling = false

    const sample = async () => {
      if (sampling) return
      sampling = true
      try {
        const current = await collectVoiceRtcDebugSnapshot(
          room,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return
        const previous = rtcDebugSnapshotRef.current
        const next = attachRtcRatesToScreenShares(
          previous
            ? { ...current, rates: deriveRtcRates(previous, current) }
            : current,
        )
        rtcDebugSnapshotRef.current = next
        diagnosticRtcHistoryRef.current = appendRtcDebugSample(
          diagnosticRtcHistoryRef.current,
          next,
        )
        recordDiagnosticEvent('rtc', 'sample', next)
        const stalledLocalScreen = next.screenShares.some(
          (screen) =>
            screen.isLocal &&
            screen.live &&
            ((screen.captureVideoPublished === true &&
              screen.captureVideoFrames === 0) ||
              (screen.captureVideoNoFrameCount ?? 0) >= 3 ||
              (screen.sentBitrate != null &&
                screen.sentBitrate <= 1_000 &&
                screen.fps === 0)),
        )
        const stalledRemoteScreen = next.screenShares.some(
          (screen) =>
            !screen.isLocal &&
            screen.live &&
            screen.subscribed === true &&
            (!screen.trackReady ||
              (screen.receivedBitrate != null &&
                screen.receivedBitrate <= 1_000 &&
                (screen.fps ?? 0) === 0)),
        )
        stalledLocalScreenSamplesRef.current = stalledLocalScreen
          ? stalledLocalScreenSamplesRef.current + 1
          : 0
        stalledRemoteScreenSamplesRef.current = stalledRemoteScreen
          ? stalledRemoteScreenSamplesRef.current + 1
          : 0
        if (
          stalledLocalScreenSamplesRef.current === 3 &&
          auth.session?.token
        ) {
          enqueueAutomaticDiagnosticIncident({
            area: 'screen',
            severity: 'error',
            triggerCode: 'screen_publication_stalled',
            context: next,
          })
        }
        if (
          stalledRemoteScreenSamplesRef.current === 3 &&
          auth.session?.token
        ) {
          enqueueAutomaticDiagnosticIncident({
            area: 'screen',
            severity: 'error',
            triggerCode: 'screen_subscription_stalled',
            context: next,
          })
        }
        if (rtcDebugEnabled) {
          setRtcDebugSnapshot(next)
          setRtcDebugHistory((history) => appendRtcDebugSample(history, next))
        }
      } finally {
        sampling = false
      }
    }

    void sample()
    const interval = window.setInterval(
      () => void sample(),
      rtcDebugEnabled ? 1_000 : 5_000,
    )
    return () => {
      active = false
      window.clearInterval(interval)
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

  const setFocusedMediaId = useCallback((mediaId: string | null) => {
    setFocusedMediaIdState(mediaId)
    if (mediaId) setStageFocusNonce((nonce) => nonce + 1)
  }, [])

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
      const activeRoom = clientRef.current?.room()
      const currentSnapshot = clientRef.current?.snapshot()
      if (
        activeRoom &&
        currentSnapshot?.connection === 'connected' &&
        currentSnapshot.membershipChannelId === targetChannelId
      ) {
        updateScreenViewerNotification(
          activeRoom,
          mediaId,
          userId,
          true,
        )
      }
      setFocusedMediaId(mediaId)
    },
    [channelId, join, setFocusedMediaId, status, updateScreenViewerNotification],
  )

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const item = stageMediaItems.find((candidate) => candidate.id === mediaId)
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
          if (room) {
            updateScreenViewerNotification(room, item.id, item.userId, subscribed)
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
        if (room) {
          updateScreenViewerNotification(
            room,
            mediaId,
            screenUserId,
            subscribed,
          )
        }
      } else {
        item?.publication?.setSubscribed?.(subscribed)
      }
      setRoomRevision((revision) => revision + 1)
    },
    [
      cancelScreenRepublishGrace,
      channelId,
      dispatchVoice,
      room,
      stageMediaItems,
      updateScreenViewerNotification,
    ],
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
      cameraEnabled: snapshot.camera.state === 'running',
      screenShareEnabled: snapshot.screen.state === 'running',
      screenShareStarting: snapshot.screen.state === 'starting',
      toggleCamera,
      toggleScreenShare,
      setSelfMonitoringActive,
      getNativeMicrophonePreviewTrack: () => null,
    }),
    [
      mediaAvailability,
      micIssue,
      setSelfMonitoringActive,
      snapshot.camera.state,
      snapshot.screen.state,
      toggleCamera,
      toggleScreenShare,
    ],
  )

  const stageValue = useMemo<VoiceStageContextValue>(
    () => ({
      stageChannelId: channelId,
      stageMediaItems,
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
      viewedRemoteScreenIds,
      watchParticipantScreenShare,
    ],
  )

  const telemetryValue = useMemo<VoiceTelemetryContextValue>(
    () => ({
      voicePingMs: null,
      voicePingHistory: [],
      rtcDebugEnabled,
      setRtcDebugEnabled,
      rtcDebugSnapshot,
      rtcDebugHistory,
    }),
    [rtcDebugEnabled, rtcDebugHistory, rtcDebugSnapshot],
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

function isElectronRenderer(userAgent = globalThis.navigator?.userAgent ?? '') {
  return /\bElectron\//i.test(userAgent)
}

function createDesktopBridgeUnavailableVoiceClient(): VoiceClient {
  let snapshot = INITIAL_SNAPSHOT
  const listeners = new Set<(value: VoiceSnapshot) => void>()
  const publish = () => listeners.forEach((listener) => listener(snapshot))
  return {
    dispatch(command) {
      if (command.type !== 'join') return
      snapshot = {
        ...INITIAL_SNAPSHOT,
        intentChannelId: command.channelId,
        connection: 'failed',
        failure: {
          code: 'desktop_bridge_unavailable',
          message: 'Desktop voice bridge is unavailable',
          retryable: false,
          stage: 'desktop_preload',
        },
      }
      publish()
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
    dispose() { listeners.clear() },
  }
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
  return {
    dispatch: (command) => director.dispatch(command),
    snapshot: () => director.snapshot(),
    subscribe: (listener) => director.subscribe(listener),
    room: () => engine.room(),
    subscribeRoom: (listener) => engine.subscribeRoom(listener),
    async dispose() {
      await director.dispose()
      await engine.dispose()
      authority.dispose()
    },
  }
}

function createDesktopVoiceClient(
  desktop: NonNullable<ReturnType<typeof getSyrnikeDesktop>>,
): VoiceClient {
  let snapshot = INITIAL_SNAPSHOT
  const listeners = new Set<(value: VoiceSnapshot) => void>()
  const unsubscribe = desktop.voice.onSnapshot((next) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  })
  void desktop.voice.getSnapshot().then((next) => {
    snapshot = next
    for (const listener of listeners) listener(next)
  })
  return {
    dispatch(command) {
      void desktop.voice.dispatch(command).catch((error) => {
        toast.error(
          error instanceof Error ? error.message : 'Native voice command failed',
        )
      })
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
      unsubscribe()
      listeners.clear()
    },
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

function nativeScreenDemandKey(
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
