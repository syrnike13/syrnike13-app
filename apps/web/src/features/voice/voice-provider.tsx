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
  type VideoTrack,
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
import { mergeSpeakingUserIds } from '#/features/voice/voice-speaking-users'
import {
  nativeVideoRegistry,
  type NativeVideoRegistryTrack,
} from '#/features/voice/native-video-registry'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import {
  buildVoiceMediaAvailabilityState,
  type VoiceMediaAvailabilityState,
} from '#/features/voice/voice-media-availability'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import {
  readStageMediaFilters,
  writeStageMediaFilters,
} from '#/features/voice/voice-stage-filters'
import {
  buildStageMediaItems,
  stageMediaItemId,
  type StageMediaFilters,
  type StageMediaTrackEntry,
} from '#/features/voice/voice-stage-media'
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
  VoiceStageMediaPublication,
} from '#/features/voice/voice-context'
import { withConnectingLocalAvatarItem } from '#/features/voice/voice-connecting-preview'
import {
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  type RtcDebugSnapshot,
  type RtcDebugStageMediaItem,
} from '#/features/voice/voice-rtc-debug'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import { playUiSound } from '#/features/sounds/sound-player'
import { getSyrnikeDesktop } from '#/platform/runtime'

type VoiceClient = {
  dispatch(command: VoiceCommand): void
  snapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
  room(): Room | null
  subscribeRoom(listener: (room: Room | null) => void): () => void
  subscribeSpeaking(listener: (ids: ReadonlySet<string>) => void): () => void
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
  useEffect(() => {
    if (!desktop) return
    nativeVideoRegistry.start()
    const update = () => setNativeVideoTracks(nativeVideoRegistry.listTracks())
    update()
    return nativeVideoRegistry.subscribe(update)
  }, [desktop])
  const clientRef = useRef<VoiceClient | null>(null)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(INITIAL_SNAPSHOT)
  const [room, setRoom] = useState<Room | null>(null)
  const [roomRevision, setRoomRevision] = useState(0)
  const [engineSpeakingUserIds, setEngineSpeakingUserIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [nativeSelfSpeaking, setNativeSelfSpeaking] = useState(false)
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [focusedMediaId, setFocusedMediaIdState] = useState<string | null>(null)
  const [stageFocusNonce, setStageFocusNonce] = useState(0)
  const [stageFullscreen, setStageFullscreen] = useState(false)
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const previousFailureRef = useRef<string | null>(null)
  const previousMediaFailureRef = useRef<string | null>(null)

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
    clientRef.current = client
    setSnapshot(client.snapshot())
    setRoom(client.room())
    const unsubscribeSnapshot = client.subscribe(setSnapshot)
    const unsubscribeRoom = client.subscribeRoom(setRoom)
    const unsubscribeSpeaking = client.subscribeSpeaking((ids) => {
      setEngineSpeakingUserIds(
        new Set([...ids].map(baseVoiceIdentity).filter(Boolean)),
      )
    })
    syncPreferences(client)

    return () => {
      unsubscribeSnapshot()
      unsubscribeRoom()
      unsubscribeSpeaking()
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

  useEffect(() => {
    if (!desktop) return
    setEngineSpeakingUserIds(
      new Set(snapshot.speakingUserIds.map(baseVoiceIdentity).filter(Boolean)),
    )
  }, [desktop, snapshot.speakingUserIds])

  useEffect(() => {
    if (
      !desktop ||
      snapshot.connection !== 'connected' ||
      snapshot.microphone.state !== 'running' ||
      snapshot.effectiveMuted
    ) {
      setNativeSelfSpeaking(false)
      return
    }
    return desktop.media.onMicrophoneMetrics((metrics) => {
      setNativeSelfSpeaking(metrics.open)
    })
  }, [
    desktop,
    snapshot.connection,
    snapshot.effectiveMuted,
    snapshot.microphone.state,
  ])

  const speakingUserIds = useMemo(
    () =>
      desktop
        ? mergeSpeakingUserIds({
            remoteUserIds: engineSpeakingUserIds,
            selfUserId: auth.user?._id ?? null,
            selfSpeaking: nativeSelfSpeaking,
          })
        : engineSpeakingUserIds,
    [auth.user?._id, desktop, engineSpeakingUserIds, nativeSelfSpeaking],
  )

  useEffect(() => {
    if (!room) return
    const refresh = () => setRoomRevision((revision) => revision + 1)
    room.on(RoomEvent.ParticipantConnected, refresh)
    room.on(RoomEvent.ParticipantDisconnected, refresh)
    room.on(RoomEvent.TrackSubscribed, refresh)
    room.on(RoomEvent.TrackUnsubscribed, refresh)
    room.on(RoomEvent.TrackPublished, refresh)
    room.on(RoomEvent.TrackUnpublished, refresh)
    room.on(RoomEvent.TrackMuted, refresh)
    room.on(RoomEvent.TrackUnmuted, refresh)
    return () => {
      room.off(RoomEvent.ParticipantConnected, refresh)
      room.off(RoomEvent.ParticipantDisconnected, refresh)
      room.off(RoomEvent.TrackSubscribed, refresh)
      room.off(RoomEvent.TrackUnsubscribed, refresh)
      room.off(RoomEvent.TrackPublished, refresh)
      room.off(RoomEvent.TrackUnpublished, refresh)
      room.off(RoomEvent.TrackMuted, refresh)
      room.off(RoomEvent.TrackUnmuted, refresh)
    }
  }, [room])

  useEffect(() => {
    const failureKey = snapshot.failure
      ? `${snapshot.failure.code}:${snapshot.operationId ?? ''}`
      : null
    if (failureKey && failureKey !== previousFailureRef.current) {
      toast.error(snapshot.failure?.message ?? 'Не удалось подключиться к голосу')
    }
    previousFailureRef.current = failureKey
  }, [snapshot.failure, snapshot.operationId])

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
    }
    previousMediaFailureRef.current = failureKey
  }, [
    snapshot.camera.error,
    snapshot.microphone.error,
    snapshot.operationId,
    snapshot.output.error,
    snapshot.screen.error,
    snapshot.screenAudio.error,
  ])

  const dispatchVoice = useCallback(async (command: VoiceCommand) => {
    const client = clientRef.current
    if (!client) throw new Error('Voice controller is not ready')
    client.dispatch(command)
  }, [])

  const join = useCallback(
    async (channelId: string) => {
      const channel = syncStore.getState().channels[channelId]
      if (!canJoinVoiceChannel(channel)) {
        toast.error('Голос недоступен в этом канале')
        return false
      }
      try {
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
    [auth.user?._id, dispatchVoice],
  )

  const leave = useCallback(() => {
    void dispatchVoice({ type: 'leave' })
    playUiSound('voice.disconnect')
  }, [dispatchVoice])

  const toggleMic = useCallback(() => {
    const enabled = snapshot.userMuted
    voicePreferenceStore.setMicEnabled(enabled)
    void dispatchVoice({ type: 'setUserMuted', muted: !enabled })
    playUiSound(enabled ? 'voice.unmute' : 'voice.mute')
  }, [dispatchVoice, snapshot.userMuted])

  const toggleDeafen = useCallback(() => {
    const deafened = !snapshot.userDeafened
    voicePreferenceStore.setDeafened(deafened)
    void dispatchVoice({ type: 'setUserDeafened', deafened })
    playUiSound(deafened ? 'voice.deafen' : 'voice.undeafen')
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
      playUiSound('screen_share.stopped')
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

  const stageMediaItems = useMemo(() => {
    const items = buildStageItems({
      room,
      participants,
      currentUserId: auth.user?._id ?? null,
      filters: stageMediaFilters,
      nativeTracks: nativeVideoTracks,
      setNativeDemand: (track, demanded) => desktop?.media.setRemoteVideoDemand(
        track.sessionId,
        track.generation,
        track.trackId,
        demanded,
      ),
    })
    return withConnectingLocalAvatarItem(items, {
      connecting: status === 'connecting' && channelId != null,
      localUserId: auth.user?._id,
      filters: stageMediaFilters,
    })
  }, [
    auth.user?._id,
    channelId,
    participants,
    room,
    roomRevision,
    nativeVideoTracks,
    stageMediaFilters,
    status,
  ])
  stageMediaItemsRef.current = stageMediaItems

  useEffect(() => {
    if (snapshot.connection !== 'connected' || !room) {
      rtcDebugSnapshotRef.current = null
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    if (!rtcDebugEnabled) return

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
        const next: RtcDebugSnapshot = previous
          ? { ...current, rates: deriveRtcRates(previous, current) }
          : current
        rtcDebugSnapshotRef.current = next
        setRtcDebugSnapshot(next)
        setRtcDebugHistory((history) => appendRtcDebugSample(history, next))
        logVoiceDebugAgent({
          hypothesis: 'native-publisher-browser-receive-boundary',
          event: 'rtc-debug-snapshot',
          transport: next.transport,
          inboundAudio: next.inbound.filter((stream) => stream.kind === 'audio'),
          outboundAudio: next.outbound.filter((stream) => stream.kind === 'audio'),
        })
      } finally {
        sampling = false
      }
    }

    void sample()
    const interval = window.setInterval(() => void sample(), 1_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [room, rtcDebugEnabled, snapshot.connection])

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
      if (channelId !== targetChannelId || status !== 'connected') {
        const joined = await join(targetChannelId)
        if (!joined) return
      }
      setFocusedMediaId(stageMediaItemId(userId, 'screen'))
    },
    [channelId, join, setFocusedMediaId, status],
  )

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const item = stageMediaItems.find((candidate) => candidate.id === mediaId)
      item?.publication?.setSubscribed?.(subscribed)
      setRoomRevision((revision) => revision + 1)
    },
    [stageMediaItems],
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
      stageMediaItems,
      focusedMediaId,
      setFocusedMediaId,
      stageFocusNonce,
      watchParticipantScreenShare,
      stageMediaFilters,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFullscreen,
      toggleStageFullscreen: () => setStageFullscreen((value) => !value),
    }),
    [
      focusedMediaId,
      setFocusedMediaId,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFocusNonce,
      stageFullscreen,
      stageMediaFilters,
      stageMediaItems,
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
    subscribeSpeaking(listener) {
      listener(new Set())
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
    subscribeSpeaking: (listener) => engine.subscribeSpeaking(listener),
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
    subscribeSpeaking(listener) {
      listener(new Set())
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

function buildStageItems(options: {
  room: Room | null
  participants: readonly { id: string }[]
  currentUserId: string | null
  filters: StageMediaFilters
  nativeTracks: readonly NativeVideoRegistryTrack[]
  setNativeDemand: (track: NativeVideoRegistryTrack, demanded: boolean) => unknown
}): VoiceStageMediaItem[] {
  const participantIds = new Set(options.participants.map(({ id }) => id))
  const tracks: StageMediaTrackEntry<VideoTrack, VoiceStageMediaPublication>[] = []
  for (const native of options.nativeTracks) {
    const userId = baseVoiceIdentity(native.participantIdentity)
    participantIds.add(userId)
    tracks.push({
      userId,
      source: native.source,
      track: native.track as unknown as VideoTrack,
      publication: {
        source: native.source === 'screen' ? Track.Source.ScreenShare : Track.Source.Camera,
        isMuted: false,
        isSubscribed: true,
        setSubscribed: (demanded) => {
          void options.setNativeDemand(native, demanded)
        },
      },
      subscribed: true,
      live: true,
    })
  }
  if (options.room) {
    participantIds.add(baseVoiceIdentity(options.room.localParticipant.identity))
    const roomParticipants = [
      options.room.localParticipant,
      ...options.room.remoteParticipants.values(),
    ]
    for (const participant of roomParticipants) {
      const userId = baseVoiceIdentity(participant.identity)
      participantIds.add(userId)
      for (const publication of participant.trackPublications.values()) {
        const source =
          publication.source === Track.Source.ScreenShare
            ? 'screen'
            : publication.source === Track.Source.Camera
              ? 'camera'
              : null
        if (!source) continue
        tracks.push({
          userId,
          source,
          track: publication.videoTrack ?? null,
          publication,
          subscribed: publication.isSubscribed,
          live: !publication.isMuted,
        })
      }
    }
  }
  return buildStageMediaItems({
    participants: [...participantIds].map((id) => ({ id })),
    currentUserId: options.currentUserId,
    tracks,
    filters: options.filters,
  })
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
