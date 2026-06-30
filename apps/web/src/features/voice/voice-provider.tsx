import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Room,
  RoomEvent,
  Track,
} from 'livekit-client'
import { toast } from 'sonner'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import {
  createVoiceJoinRunner,
  nativeCredentialsFromJoinResponse,
  type LiveKitNativeCredentials,
  type LiveKitNativeMediaKind,
  type LiveKitNativePublisherCredentials,
  type VoiceJoinRunnerDeps,
} from '#/features/voice/voice-join'
import {
  requestVoiceCredentialsRefresh,
  requestVoiceFlagsUpdate,
  requestVoiceLeave,
} from '#/features/voice/voice-gateway'
import type { VoiceJoinReason } from '#/features/voice/voice-intent-director'
import {
  createVoiceIntentExecutor,
  type VoiceExecutorDeps,
} from '#/features/voice/voice-intent-executor'
import {
  voiceIntentActionFromGatewayEvent,
} from '#/features/voice/voice-intent-gateway-events'
import { useVoiceTelemetryDebug } from '#/features/voice/voice-debug-telemetry'
import { useVoiceMediaFlags } from '#/features/voice/voice-media-flags'
import { useVoiceFlagsController } from '#/features/voice/voice-flags-controller'
import { useVoiceStageController } from '#/features/voice/voice-stage-controller'
import { useVoiceScreenShare } from '#/features/voice/use-voice-screen-share'
import {
  shouldRefreshLiveKitToken,
} from '#/features/voice/voice-token-helpers'
import {
  applyVoiceDevices as applyVoiceDevicesToRoom,
  finishLocalVoiceSetup as finishLocalVoiceSetupFromDeps,
  readCurrentVoiceFlags as readCurrentVoiceFlagsFromState,
  restoreVoicePreferences as restoreVoicePreferencesFromStore,
  syncMicFromRoom as syncMicFromRoomState,
} from '#/features/voice/voice-local-setup'
import {
  canJoinVoiceChannel,
} from '#/features/voice/voice-api-capability'
import { syncStore } from '#/features/sync/sync-store'
import {
  createRemoteAudioMixer,
  type RemoteAudioMixer,
} from '#/features/voice/remote-audio-mixer'
import {
  applyRemoteAudio as applyRemoteAudioToMixer,
  attachRoomAudio,
  cleanupVoiceRoomAudio,
  localMicMediaStreamTrack,
  type LocalAudioTrackWithProcessor,
} from '#/features/voice/voice-room-audio'
import {
  createLocalSpeakingDetector,
  type LocalSpeakingDetector,
} from '#/features/voice/local-speaking-detector'
import { mergeSpeakingUserIds } from '#/features/voice/voice-speaking-users'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import {
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
  removeLocalUserFromAllVoiceChannels,
} from '#/features/voice/voice-participant-sync'
import {
  participantMicPublishing,
} from '#/features/voice/voice-participant-media'
import {
  voiceMicPublishOptions,
} from '#/features/voice/voice-capture'
import type {
  NativeScreenPublicationLossHandler,
} from '#/features/voice/native-screen-publication-loss'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { createVoiceOperationId } from '#/features/voice/voice-operation'
import {
  nativeOrBrowserPublisherHealthy,
} from '#/features/voice/voice-recovery-runner'
import {
  createInitialNativeMediaState,
  type NativeMediaAction,
  nativeMediaReducer,
} from '#/features/voice/native-media-coordinator'
import {
  type NativeScreenShareSession,
} from '#/features/voice/native-screen-share-publish'
import {
  configureNativeMicrophoneSession,
  publishNativeMicrophone,
  shouldRestartNativeMicrophonePublisher,
  shouldUseNativeMicrophone,
} from '#/features/voice/native-microphone-publish'
import { NativeScreenShareCoordinator } from '#/features/voice/native-screen-share-coordinator'
import { getSyrnikeDesktop } from '#/platform/runtime'
import {
  applyMicProcessing,
  refreshMicProcessing,
} from '#/features/voice/voice-mic-processing'
import { clearSessionVoiceGateThreshold } from '#/features/voice/voice-gate-session'
import { voicePreferenceEffectFlags } from '#/features/voice/voice-preference-effects'
import {
  describeMicDeviceError,
  MIC_BLOCKED_WITHOUT_ERROR,
  type VoiceConnectionPhase,
  type VoiceMicIssue,
  type VoiceStatus,
} from '#/features/voice/voice-mic-status'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { buildVoiceMediaAvailabilityState } from '#/features/voice/voice-media-availability'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  effectiveVoiceJoinPreferences,
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import {
  createConnectingLocalVoiceState,
  withConnectingLocalAvatarItem,
} from '#/features/voice/voice-connecting-preview'
import {
  screenViewerSoundEventFromData,
} from '#/features/voice/voice-screen-viewer-sounds'
import { runVoiceRequest } from '#/features/voice/voice-request-gate'
import { createVoiceTransitionRateLimiter } from '#/features/voice/voice-transition-rate-limit'
import { channelAudioBitrateKbps } from '#/lib/channel-audio-bitrate'
import { playUiSound } from '#/features/sounds/sound-player'
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

const VOICE_RECOVERY_HEALTH_INTERVAL_MS = 5_000
const VOICE_RECOVERY_SERVER_STATE_GRACE_MS = 10_000

function stringSetEquals(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of right) {
    if (!left.has(value)) return false
  }
  return true
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const roomRef = useRef<Room | null>(null)
  const nativeScreenShareRef = useRef<NativeScreenShareSession | null>(null)
  const pendingScreenShareStartRef = useRef<{
    quality: ScreenShareQualityName
    withAudio: boolean
  } | null>(null)
  const screenShareStartGenerationRef = useRef(0)
  const stoppedNativeScreenIdentityRef = useRef<string | null>(null)
  const nativeScreenPublicationLossKeyRef = useRef<string | null>(null)
  const nativeScreenPublicationLostRef =
    useRef<NativeScreenPublicationLossHandler | null>(null)
  const remoteAudioMixerRef = useRef<RemoteAudioMixer | null>(null)
  const localSpeakingDetectorRef = useRef<LocalSpeakingDetector | null>(null)
  const remoteSpeakingUserIdsRef = useRef<ReadonlySet<string>>(new Set())
  const selfSpeakingRef = useRef(false)
  const authUserIdRef = useRef<string | null>(null)
  const channelIdRef = useRef<string | null>(null)
  const statusRef = useRef<VoiceStatus>('idle')
  const localVoiceReadyRef = useRef(false)
  const voiceConnectedAtRef = useRef(0)
  const deafenedRef = useRef(false)
  const micPublishingRef = useRef(readVoicePreferences().micEnabled)
  const micIssueRef = useRef<VoiceMicIssue | null>(null)
  const voiceTransitionRateLimitRef = useRef(createVoiceTransitionRateLimiter())
  const joinRef = useRef<(channelId: string) => Promise<boolean>>(
    async () => false,
  )
  const syncRoomParticipantsRef = useRef<() => void>(() => {})
  const setScreenShareEnabledRef = useRef<(enabled: boolean) => void>(() => {})
  const stopNativeScreenShareRef = useRef<() => Promise<void>>(async () => {})
  const selfMonitoringRef = useRef({
    active: false,
    restorePublishing: false,
    sequence: 0,
  })
  authUserIdRef.current = auth.user?._id ?? null
  const voiceJoinDepsRef = useRef<VoiceJoinRunnerDeps>({
    getToken: () => undefined as string | undefined,
    getLocalUserId: () => undefined as string | undefined,
    isJoinBlocked: () => false,
    isCurrentJoinOperation: (_operationId: string) => true,
    beginConnecting: (
      _channelId: string,
      _preview: ReturnType<typeof createConnectingLocalVoiceState>[],
    ) => {},
    attachRoomHandlers: (_room: Room) => {},
    setLiveKitCredentials: (_credentials: LiveKitNativeCredentials) => {},
    setConnectionPhase: (_phase: VoiceConnectionPhase) => {},
    onRoomConnected: (_room: Room, _channelId: string) => {},
    onJoinSuccess: () => {},
    abortJoin: () => {},
  })
  const performVoiceJoinRef = useRef(
    createVoiceJoinRunner({
      getDeps: () => voiceJoinDepsRef.current,
    }),
  )
  const voiceIntentExecutorDepsRef = useRef<VoiceExecutorDeps>({
    getToken: () => undefined,
    getLocalUserId: () => undefined,
    isJoinBlocked: () => false,
    getActiveSession: () => null,
    performVoiceJoin: async () => false,
    requestVoiceLeave: () => {},
    shouldKeepRejoining: () => false,
    attachRoomHandlers: () => {},
    onRoomConnected: () => {},
    onAbort: () => {},
    beginVisualTransition: () => {},
    clearVisualPresence: () => {},
    completeTerminalLeave: async () => {},
    disconnectLocalSession: async () => {},
    disconnectMoveSource: async () => {},
    onRoomChanged: () => {},
    setLiveKitCredentials: () => {},
    setConnectionPhase: () => {},
    recovery: {
      getGatewayConnected: () => false,
      getActiveChannelId: () => null,
      getUserId: () => null,
      getStatus: () => 'idle',
      getVoiceParticipants: () => ({}),
      canTrustServerState: () => false,
      readCurrentVoiceFlags: () => ({ selfMute: false, selfDeaf: false }),
      readVoicePreferences: () => ({ micEnabled: false }),
      isSelfMonitoringActive: () => false,
      isPublisherHealthy: () => false,
      syncVoiceFlagsToGateway: () => {},
      shouldUseNativeMicrophone: () => false,
      startNativeMicrophone: async () => false,
      isCurrentVoiceSession: () => false,
      syncMicFromRoom: () => {},
      syncRoomParticipants: () => {},
      syncLocalSpeakingTrack: () => {},
      activeChannelAudioBitrateKbps: () => 64,
      applyMicProcessing: async () => {},
      getSelfDeafened: () => false,
    },
  })
  const voiceIntentExecutorRef = useRef(
    createVoiceIntentExecutor({
      getDeps: () => voiceIntentExecutorDepsRef.current,
    }),
  )
  const nativeMedia = voiceIntentExecutorRef.current.nativeMedia
  const lastVoicePreferencesRef = useRef(readVoicePreferences())

  const [channelId, setChannelId] = useState<string | null>(null)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [connectionPhase, setConnectionPhase] =
    useState<VoiceConnectionPhase>('idle')
  const [localVoiceReady, setLocalVoiceReady] = useState(false)
  const [micEnabled, setMicEnabled] = useState(
    () => readVoicePreferences().micEnabled,
  )
  const [micPublishing, setMicPublishing] = useState(
    () => readVoicePreferences().micEnabled,
  )
  const [micIssue, setMicIssue] = useState<VoiceMicIssue | null>(null)
  const inputDevices = useMediaDevices('audioinput')
  const videoDevices = useMediaDevices('videoinput')
  const [deafened, setDeafened] = useState(
    () => readVoicePreferences().deafened,
  )
  const [participantCount, setParticipantCount] = useState(0)
  const [speakingUserIds, setSpeakingUserIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const publishSpeakingUserIds = useCallback(() => {
    const next = mergeSpeakingUserIds({
      remoteUserIds: remoteSpeakingUserIdsRef.current,
      selfUserId: authUserIdRef.current,
      selfSpeaking: selfSpeakingRef.current,
    })
    setSpeakingUserIds((current) =>
      stringSetEquals(current, next) ? current : next,
    )
  }, [])
  const setRemoteSpeakingUserIds = useCallback(
    (next: ReadonlySet<string>) => {
      if (stringSetEquals(remoteSpeakingUserIdsRef.current, next)) return
      remoteSpeakingUserIdsRef.current = new Set(next)
      publishSpeakingUserIds()
    },
    [publishSpeakingUserIds],
  )
  const setSelfSpeaking = useCallback(
    (speaking: boolean) => {
      if (selfSpeakingRef.current === speaking) return
      selfSpeakingRef.current = speaking
      publishSpeakingUserIds()
    },
    [publishSpeakingUserIds],
  )
  if (!remoteAudioMixerRef.current) {
    remoteAudioMixerRef.current = createRemoteAudioMixer({
      onSpeakingUserIdsChange: setRemoteSpeakingUserIds,
    })
  }
  if (!localSpeakingDetectorRef.current) {
    localSpeakingDetectorRef.current = createLocalSpeakingDetector({
      onSpeakingChange: setSelfSpeaking,
    })
  }
  useEffect(() => {
    publishSpeakingUserIds()
  }, [auth.user?._id, publishSpeakingUserIds])
  const [nativeMediaState, dispatchNativeMediaState] = useReducer(
    nativeMediaReducer,
    undefined,
    createInitialNativeMediaState,
  )
  const nativeMediaStateRef = useRef(nativeMediaState)
  nativeMediaStateRef.current = nativeMediaState
  const dispatchNativeMedia = useCallback((action: NativeMediaAction) => {
    nativeMediaStateRef.current = nativeMediaReducer(
      nativeMediaStateRef.current,
      action,
    )
    dispatchNativeMediaState(action)
  }, [])
  channelIdRef.current = channelId
  statusRef.current = status
  localVoiceReadyRef.current = localVoiceReady
  deafenedRef.current = deafened
  micPublishingRef.current = micPublishing

  const isCurrentVoiceSession = useCallback(
    (room: Room, targetChannelId: string | null) =>
      roomRef.current === room &&
      channelIdRef.current === targetChannelId &&
      statusRef.current === 'connected',
    [],
  )

  const setCurrentMicIssue = useCallback(
    (issue: VoiceMicIssue | null, notify = false) => {
      const previous = micIssueRef.current
      micIssueRef.current = issue
      setMicIssue(issue)

      if (issue && notify && previous?.hint !== issue.hint) {
        toast.error(issue.hint)
      }
    },
    [],
  )

  const syncRoomParticipantsFromRef = useCallback(() => {
    syncRoomParticipantsRef.current()
  }, [])
  const joinFromRef = useCallback((targetChannelId: string) => {
    return joinRef.current(targetChannelId)
  }, [])
  const setScreenShareEnabledFromRef = useCallback((enabled: boolean) => {
    setScreenShareEnabledRef.current(enabled)
  }, [])
  const stopNativeScreenShareFromRef = useCallback(async () => {
    await stopNativeScreenShareRef.current()
  }, [])

  const {
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
  } = useVoiceStageController({
    authUserId: auth.user?._id ?? null,
    channelId,
    status,
    join: joinFromRef,
    roomRef,
    nativeMediaStateRef,
    stoppedNativeScreenIdentityRef,
    nativeScreenShareRef,
    stopNativeScreenShare: stopNativeScreenShareFromRef,
    setScreenShareEnabled: setScreenShareEnabledFromRef,
    syncRoomParticipants: syncRoomParticipantsFromRef,
    onNativeScreenPublicationLost: (loss) => {
      nativeScreenPublicationLostRef.current?.(loss)
    },
    logStageSyncDebug: logVoiceDebugAgent,
  })

  const {
    voicePingMs,
    voicePingHistory,
    rtcDebugEnabled,
    setRtcDebugEnabled,
    rtcDebugSnapshot,
    rtcDebugHistory,
    screenShareDebugUntilRef,
    setScreenShareDebugRun,
    resetVoiceTelemetryDebugState,
  } = useVoiceTelemetryDebug({
    status,
    roomRef,
    stageMediaItemsRef,
  })

  const {
    cameraEnabled,
    screenShareStarting,
    screenShareEnabledForUi,
    screenShareStartingForUi,
    setCameraEnabled,
    setScreenShareEnabled,
    setScreenShareStarting,
    screenShareStartingRef,
    syncRoomParticipants,
    toggleCamera,
  } = useVoiceMediaFlags({
    authUserId: auth.user?._id ?? null,
    roomRef,
    channelIdRef,
    nativeMediaState,
    nativeMediaStateRef,
    syncStageMediaItems,
  })
  syncRoomParticipantsRef.current = syncRoomParticipants
  setScreenShareEnabledRef.current = setScreenShareEnabled

  const cleanupAudio = useCallback(() => {
    cleanupVoiceRoomAudio({
      getRemoteAudioMixer: () => remoteAudioMixerRef.current,
      getLocalSpeakingDetector: () => localSpeakingDetectorRef.current,
      setSelfSpeaking,
    })
  }, [setSelfSpeaking])

  const applyRemoteAudio = useCallback((deafened = deafenedRef.current) => {
    applyRemoteAudioToMixer({
      getRemoteAudioMixer: () => remoteAudioMixerRef.current,
      isDeafened: () => deafened,
    })
  }, [])

  const syncLocalSpeakingTrack = useCallback(
    (room = roomRef.current) => {
      const detector = localSpeakingDetectorRef.current
      if (!detector) return

      if (!room || shouldUseNativeMicrophone()) {
        detector.clear()
        detector.setEnabled(false)
        if (!shouldUseNativeMicrophone()) {
          setSelfSpeaking(false)
        }
        return
      }

      const micPublication = room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      )
      const audioTrack = micPublication?.audioTrack as
        | LocalAudioTrackWithProcessor
        | undefined
      const mediaStreamTrack = localMicMediaStreamTrack(audioTrack)
      const enabled =
        participantMicPublishing(room.localParticipant) &&
        !deafenedRef.current &&
        !selfMonitoringRef.current.active

      detector.setTrack(mediaStreamTrack)
      detector.setEnabled(enabled)
      if (!mediaStreamTrack || !enabled) {
        setSelfSpeaking(false)
      }
    },
    [setSelfSpeaking],
  )

  const restoreVoicePreferences = useCallback(() => {
    restoreVoicePreferencesFromStore({
      readPreferences: readVoicePreferences,
      setMicEnabled,
      setMicPublishing,
      setCurrentMicIssue,
      setDeafened,
      setDeafenedRef: (deafened) => {
        deafenedRef.current = deafened
      },
    })
  }, [setCurrentMicIssue])

  const syncMicFromRoom = useCallback(
    (room: Room, issue?: VoiceMicIssue | null) => {
      syncMicFromRoomState({
        room,
        issue,
        wantsMic: voicePreferenceStore.getMicEnabled(),
        shouldUseNativeMicrophone: shouldUseNativeMicrophone(),
        hasNativeMicrophone: nativeMedia.hasActiveMicrophone(),
        nativeMicrophoneMuted: nativeMedia.isMicrophoneMuted(),
        activeChannelId: channelIdRef.current,
        userId: auth.user?._id ?? null,
        currentMicIssue: micIssueRef.current,
        fallbackIssue: MIC_BLOCKED_WITHOUT_ERROR,
        setMicPublishing,
        resetMicPreference: (enabled) => {
          voicePreferenceStore.setMicEnabled(enabled)
        },
        setMicEnabled,
        setCurrentMicIssue,
        patchLocalVoiceMic,
      })
    },
    [auth.user?._id, nativeMedia, setCurrentMicIssue],
  )

  const syncVoiceFlagsToGateway = useCallback(
    (channelId: string, selfMute: boolean, selfDeaf: boolean) => {
      requestVoiceFlagsUpdate(channelId, selfMute, selfDeaf)
    },
    [],
  )

  const readCurrentVoiceFlags = useCallback((room = roomRef.current) => {
    return readCurrentVoiceFlagsFromState({
      room,
      selfDeaf: deafenedRef.current,
      selfMonitoringActive: selfMonitoringRef.current.active,
      shouldUseNativeMicrophone: shouldUseNativeMicrophone(),
      hasNativeMicrophone: nativeMedia.hasActiveMicrophone(),
      nativeMicrophoneMuted: nativeMedia.isMicrophoneMuted(),
      fallbackMicPublishing: micPublishingRef.current,
    })
  }, [nativeMedia])

  const refreshNativeLiveKitCredentials = useCallback(
    async (
      mediaKind: LiveKitNativeMediaKind,
      force = false,
    ): Promise<LiveKitNativePublisherCredentials> => {
      return nativeMedia.refreshLiveKitCredentials({
        channelIdRef,
        readCurrentVoiceFlags,
        shouldRefreshLiveKitToken,
        runVoiceRequest,
        requestCredentialsRefresh: requestVoiceCredentialsRefresh,
        createOperationId: createVoiceOperationId,
        nativeCredentialsFromJoinResponse,
        getDesktop: getSyrnikeDesktop,
      }, mediaKind, force)
    },
    [auth.gatewayState, nativeMedia, readCurrentVoiceFlags],
  )

  const activeChannelAudioBitrateKbps = useCallback(() => {
    const activeChannelId = channelIdRef.current
    const channel = activeChannelId
      ? syncStore.getState().channels[activeChannelId]
      : null
    return channelAudioBitrateKbps(
      channel && 'voice' in channel ? channel : {},
    )
  }, [])

  const resetVoiceState = useCallback(() => {
    nativeMedia.reset({
      screenShareStartGenerationRef,
      screenShareStartingRef,
      pendingScreenShareStartRef,
      selfMonitoringRef,
      nativeScreenShareRef,
      stoppedNativeScreenIdentityRef,
      nativeScreenPublicationLossKeyRef,
      resetNativeMediaEngineStats: () => nativeMediaEngineStatsStore.reset(),
      getDesktop: getSyrnikeDesktop,
      clearWatchedScreenIds: false,
      resetStatsWithoutActiveScreen: false,
    })
    setChannelId(null)
    setStatus('idle')
    voiceConnectedAtRef.current = 0
    setConnectionPhase('idle')
    setLocalVoiceReady(false)
    restoreVoicePreferences()
    setCurrentMicIssue(null)
    setParticipantCount(0)
    remoteSpeakingUserIdsRef.current = new Set()
    selfSpeakingRef.current = false
    setSpeakingUserIds((current) => (current.size === 0 ? current : new Set()))
    resetVoiceTelemetryDebugState()
    resetStageState()
    setCameraEnabled(false)
    setScreenShareEnabled(false)
    setScreenShareStarting(false)
    dispatchNativeMedia({ type: 'reset' })
  }, [
    restoreVoicePreferences,
    nativeMedia,
    resetStageState,
    resetVoiceTelemetryDebugState,
    setCurrentMicIssue,
  ])

  const abortJoinAttempt = useCallback(() => {
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    if (activeChannelId && userId) {
      syncStore.removeVoiceParticipant(activeChannelId, userId)
    }
    cleanupAudio()
    resetVoiceState()
  }, [auth.user?._id, cleanupAudio, resetVoiceState])

  const getActiveVoiceOperationId = useCallback(() => {
    return voiceIntentExecutorRef.current.getState().activeOperationId
  }, [])

  const leave = useCallback(() => {
    voiceTransitionRateLimitRef.current.record(Date.now())
    voiceIntentExecutorRef.current.clearIntent()
  }, [getActiveVoiceOperationId])

  const applyVoiceDevices = useCallback(async (room: Room) => {
    await applyVoiceDevicesToRoom({
      room,
      readPreferences: readVoicePreferences,
      shouldUseNativeMicrophone: shouldUseNativeMicrophone(),
      setRemoteAudioOutputDevice: (deviceId) => {
        remoteAudioMixerRef.current?.setOutputDevice(deviceId)
      },
      applyRemoteAudio,
      isDeafened: () => deafenedRef.current,
    })
  }, [applyRemoteAudio])

  const setNativeMicrophoneMuted = useCallback(
    async (muted: boolean) => {
      await nativeMedia.setMicrophoneMuted({
        setMicPublishing,
        setSelfSpeaking,
        syncRoomParticipants,
      }, muted)
    },
    [nativeMedia, setSelfSpeaking, syncRoomParticipants],
  )

  const startNativeMicrophone = useCallback(
    async (room: Room, muted = false) => {
      return nativeMedia.startMicrophone({
        room,
        muted,
        getTargetChannelId: () => channelIdRef.current,
        isCurrentVoiceSession,
        publishNativeMicrophone,
        refreshNativeLiveKitCredentials,
        activeChannelAudioBitrateKbps,
        createRequestId: () => crypto.randomUUID(),
        onNativeMicrophoneStopped: (sessionId) => {
          if (!nativeMedia.handleMicrophoneStopped(sessionId)) return
          setMicPublishing(false)
          setSelfSpeaking(false)
          const activeChannelId = channelIdRef.current
          const userId = auth.user?._id
          if (activeChannelId && userId) {
            patchLocalVoiceMic(activeChannelId, userId, false)
            syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
          }
          syncRoomParticipants()

          const prefs = readVoicePreferences()
          const room = roomRef.current
          const shouldRestart =
            room &&
            shouldRestartNativeMicrophonePublisher({
              voiceConnected: statusRef.current === 'connected',
              wantsMic: prefs.micEnabled,
              deafened: deafenedRef.current,
              selfMonitoringActive: selfMonitoringRef.current.active,
            })

          if (!shouldRestart) return

          void startNativeMicrophone(room, false)
            .then((started) => {
              if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room)
              syncRoomParticipants()
              if (activeChannelId && userId && statusRef.current === 'connected') {
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
              if (activeChannelId && userId && statusRef.current === 'connected') {
                syncVoiceFlagsToGateway(
                  activeChannelId,
                  true,
                  deafenedRef.current,
                )
              }
            })
        },
        setMicPublishing,
        setSelfSpeaking,
        syncRoomParticipants,
      })
    },
    [
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps,
      auth.user?._id,
      isCurrentVoiceSession,
      nativeMedia,
      readCurrentVoiceFlags,
      setSelfSpeaking,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const finishLocalVoiceSetup = useCallback(
    async (room: Room, targetChannelId: string) => {
      await finishLocalVoiceSetupFromDeps({
        room,
        targetChannelId,
        isCurrentVoiceSession,
        readPreferences: () =>
          effectiveVoiceJoinPreferences(readVoicePreferences()),
        getMicEnabledPreference: () => voicePreferenceStore.getMicEnabled(),
        selfMonitoringActive: selfMonitoringRef.current.active,
        setSelfMonitoringRestorePublishing: (restorePublishing) => {
          selfMonitoringRef.current.restorePublishing = restorePublishing
        },
        shouldUseNativeMicrophone: shouldUseNativeMicrophone(),
        startNativeMicrophone,
        voiceMicPublishOptions,
        activeChannelAudioBitrateKbps,
        describeMicDeviceError,
        setConnectionPhase,
        syncMicFromRoom,
        setMicEnabled,
        setMicPublishing,
        setCurrentMicIssue,
        setDeafened,
        setDeafenedRef: (deafened) => {
          deafenedRef.current = deafened
        },
        applyRemoteAudio,
        applyVoiceDevices,
        applyMicProcessing,
        syncLocalSpeakingTrack,
        syncRoomParticipants,
        getUserId: () => auth.user?._id ?? null,
        hasNativeMicrophonePublishing: () =>
          nativeMedia.hasMicrophonePublishing(),
        patchLocalVoiceDeafen,
        syncVoiceFlagsToGateway,
        setLocalVoiceReady,
      })
    },
    [
      applyVoiceDevices,
      auth.user?._id,
      isCurrentVoiceSession,
      nativeMedia,
      setCurrentMicIssue,
      startNativeMicrophone,
      activeChannelAudioBitrateKbps,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const {
    setSelfMonitoringActive,
    toggleMic,
    toggleDeafen,
  } = useVoiceFlagsController({
    authUserId: auth.user?._id ?? null,
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
  })

  const disconnectNativeMediaForHandoff = useCallback(() => {
    nativeMedia.disconnectForHandoff({
      screenShareStartGenerationRef,
      screenShareStartingRef,
      pendingScreenShareStartRef,
      selfMonitoringRef,
      nativeScreenShareRef,
      stoppedNativeScreenIdentityRef,
      nativeScreenPublicationLossKeyRef,
      resetNativeMediaEngineStats: () => nativeMediaEngineStatsStore.reset(),
      getDesktop: getSyrnikeDesktop,
      setMicPublishing,
      setSelfSpeaking,
      setScreenShareEnabled,
      setScreenShareStarting,
      setCameraEnabled,
      dispatchNativeMedia,
    })
  }, [
    dispatchNativeMedia,
    nativeMedia,
    setCameraEnabled,
    setScreenShareEnabled,
    setScreenShareStarting,
    setSelfSpeaking,
  ])

  const attachAudio = useCallback(
    (room: Room) => {
      attachRoomAudio(room, {
        currentUserId: auth.user?._id ?? null,
        getRemoteAudioMixer: () => remoteAudioMixerRef.current,
        getDeafened: () => deafenedRef.current,
        getNativeScreenState: () => nativeMediaStateRef.current.screen,
        getStoppedNativeScreenIdentity: () =>
          stoppedNativeScreenIdentityRef.current,
        getCurrentRoom: () => roomRef.current,
        getTargetChannelId: () => channelIdRef.current,
        markConnected: () => {
          statusRef.current = 'connected'
          voiceConnectedAtRef.current = Date.now()
          setStatus('connected')
        },
        setParticipantCount,
        syncRoomParticipants,
        runVoiceRecovery: (trigger) =>
          voiceIntentExecutorRef.current.reconcileWithServer(trigger),
        syncLocalSpeakingTrack,
        applyRemoteScreenParticipantSubscription,
        syncMicFromRoom: (activeRoom, issue) => {
          syncMicFromRoom(activeRoom, issue as VoiceMicIssue | null | undefined)
        },
        abortJoinAttempt,
        onNativeScreenPublicationLost: (loss) => {
          nativeScreenPublicationLostRef.current?.(loss)
        },
        onUnexpectedRoomDisconnect: (targetChannelId) => {
          const activeRoom = roomRef.current
          if (activeRoom) {
            activeRoom.removeAllListeners()
            roomRef.current = null
          }
          const activeOperationId = getActiveVoiceOperationId()
          voiceIntentExecutorRef.current.onRoomDisconnected(
            false,
            'Room disconnected',
          )
          logVoiceDebugAgent({
            hypothesis: 'H7-unexpected-room-disconnect-native-media',
            event: 'voice-room-unexpected-disconnected',
            targetChannelId,
            activeOperationId,
            hadNativeScreenShare: Boolean(nativeScreenShareRef.current),
            nativeScreenState: nativeMediaStateRef.current.screen.status,
          })
          disconnectNativeMediaForHandoff()
          cleanupAudio()
          setStatus('connecting')
          setConnectionPhase('reconnecting')
          setLocalVoiceReady(false)
        },
        playUiSound,
        describeMicDeviceError,
      })

      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        const soundEvent = screenViewerSoundEventFromData({
          payload,
          topic,
          senderIdentity: participant?.identity,
          currentUserId: authUserIdRef.current,
        })
        if (soundEvent) playUiSound(soundEvent)
      })
    },
    [
      abortJoinAttempt,
      auth.user?._id,
      cleanupAudio,
      disconnectNativeMediaForHandoff,
      getActiveVoiceOperationId,
      applyRemoteScreenParticipantSubscription,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
    ],
  )

  const getActiveVoiceSession = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    if (
      !room ||
      !activeChannelId ||
      (statusRef.current !== 'connected' && statusRef.current !== 'connecting')
    ) {
      return null
    }
    return {
      room,
      channelId: activeChannelId,
      localVoiceReady:
        statusRef.current === 'connected' ? localVoiceReady : false,
    }
  }, [localVoiceReady])

  useEffect(() => {
    voiceJoinDepsRef.current = {
      getToken: () => auth.session?.token,
      getLocalUserId: () => auth.user?._id,
      isJoinBlocked: () => {
        const now = Date.now()
        return voiceTransitionRateLimitRef.current.isBlocked(now)
      },
      isCurrentJoinOperation: (operationId) =>
        getActiveVoiceOperationId() === operationId,
      beginConnecting: (targetChannelId, preview) => {
        const previousVisualChannelId = channelIdRef.current
        const localUserId = auth.user?._id
        if (
          localUserId &&
          previousVisualChannelId &&
          previousVisualChannelId !== targetChannelId
        ) {
          syncStore.removeVoiceParticipant(previousVisualChannelId, localUserId)
        }
        setStatus('connecting')
        setLocalVoiceReady(false)
        setChannelId(targetChannelId)
        restoreVoicePreferences()
        for (const participant of preview) {
          syncStore.addVoiceParticipant(targetChannelId, participant)
        }
      },
      attachRoomHandlers: (room) => attachAudio(room),
      setLiveKitCredentials: (credentials) => {
        nativeMedia.setLiveKitCredentials(credentials)
        const desktop = getSyrnikeDesktop()
        if (desktop?.platform.os === 'win32') {
          void desktop.media.prepareScreenSession({ livekit: credentials.screen }).catch(() => {})
        }
      },
      setConnectionPhase,
      onRoomConnected: (room, targetChannelId) => {
        setLocalVoiceReady(false)
        statusRef.current = 'connected'
        voiceConnectedAtRef.current = Date.now()
        setStatus('connected')
        syncStore.clearVoiceCallDismissal(targetChannelId)
        syncRoomParticipants()
        void finishLocalVoiceSetup(room, targetChannelId)
      },
      onJoinSuccess: () => {},
      abortJoin: abortJoinAttempt,
    }
    voiceIntentExecutorDepsRef.current = {
      getToken: () => auth.session?.token,
      getLocalUserId: () => auth.user?._id,
      isJoinBlocked: () => {
        const now = Date.now()
        return voiceTransitionRateLimitRef.current.isBlocked(now)
      },
      getActiveSession: getActiveVoiceSession,
      performVoiceJoin: (targetChannelId, options) =>
        performVoiceJoinRef.current(targetChannelId, {
          operationId: options.operationId,
          rejoin: options.reason === 'rejoin',
        }),
      requestVoiceLeave: () => {
        if (auth.gatewayState === 'connected') {
          requestVoiceLeave()
        }
      },
      shouldKeepRejoining: (channelId) =>
        Boolean(auth.session?.token) &&
        canJoinVoiceChannel(syncStore.getState().channels[channelId]),
      attachRoomHandlers: (room) => attachAudio(room),
      onRoomConnected: (room, targetChannelId) => {
        setLocalVoiceReady(false)
        statusRef.current = 'connected'
        voiceConnectedAtRef.current = Date.now()
        setStatus('connected')
        syncStore.clearVoiceCallDismissal(targetChannelId)
        syncRoomParticipants()
        void finishLocalVoiceSetup(room, targetChannelId)
      },
      onAbort: abortJoinAttempt,
      beginVisualTransition: (targetChannelId) => {
        const previousVisualChannelId = channelIdRef.current
        const localUserId = auth.user?._id
        if (
          localUserId &&
          previousVisualChannelId &&
          previousVisualChannelId !== targetChannelId
        ) {
          syncStore.removeVoiceParticipant(previousVisualChannelId, localUserId)
        }
        setStatus('connecting')
        setLocalVoiceReady(false)
        setChannelId(targetChannelId)
        restoreVoicePreferences()
      },
      clearVisualPresence: (targetChannelId) => {
        const localUserId = auth.user?._id
        if (localUserId) {
          syncStore.removeVoiceParticipant(targetChannelId, localUserId)
        }
      },
      completeTerminalLeave: async ({ channelId: leftChannelId, room }) => {
        const userId =
          room?.localParticipant.identity ??
          auth.user?._id

        if (room) {
          await publishScreenViewerLeaves(room)
          room.removeAllListeners()
          await room.disconnect().catch(() => {})
        }

        cleanupAudio()
        clearSessionVoiceGateThreshold()
        resetVoiceState()
        playUiSound('voice.disconnect')

        if (leftChannelId && userId) {
          syncStore.removeVoiceParticipant(leftChannelId, userId)
        }
        if (userId) {
          removeLocalUserFromAllVoiceChannels(userId)
        }
      },
      disconnectLocalSession: async ({ channelId: leftChannelId, room }) => {
        const userId =
          room?.localParticipant.identity ??
          auth.user?._id

        if (room) {
          await publishScreenViewerLeaves(room)
          room.removeAllListeners()
          await room.disconnect().catch(() => {})
          if (roomRef.current === room) {
            roomRef.current = null
          }
        }

        cleanupAudio()
        clearSessionVoiceGateThreshold()
        resetVoiceState()

        if (leftChannelId && userId) {
          syncStore.removeVoiceParticipant(leftChannelId, userId)
        }
        if (userId) {
          removeLocalUserFromAllVoiceChannels(userId)
        }
      },
      disconnectMoveSource: async ({ room, channelId }) => {
        await publishScreenViewerLeaves(room)
        room.removeAllListeners()
        await room.disconnect().catch(() => {})
        if (roomRef.current === room) {
          roomRef.current = null
        }
        const userId = auth.user?._id ?? room.localParticipant.identity
        if (userId) {
          syncStore.removeVoiceParticipant(channelId, userId)
        }
      },
      onRoomChanged: (room) => {
        roomRef.current = room
      },
      setLiveKitCredentials: (credentials) => {
        nativeMedia.setLiveKitCredentials(credentials)
      },
      setConnectionPhase,
      recovery: {
        getGatewayConnected: () => auth.gatewayState === 'connected',
        getActiveChannelId: () => channelIdRef.current,
        getUserId: () => auth.user?._id ?? null,
        getStatus: () => statusRef.current,
        getVoiceParticipants: () => syncStore.getState().voiceParticipants,
        canTrustServerState: (recoveryTrigger) =>
          recoveryTrigger === 'gateway_connected' ||
          (voiceConnectedAtRef.current > 0 &&
            Date.now() - voiceConnectedAtRef.current >=
              VOICE_RECOVERY_SERVER_STATE_GRACE_MS),
        readCurrentVoiceFlags,
        readVoicePreferences,
        isSelfMonitoringActive: () => selfMonitoringRef.current.active,
        isPublisherHealthy: (room) =>
          nativeOrBrowserPublisherHealthy(room, {
            shouldUseNativeMicrophone,
            hasActiveNativeMicrophone: () => nativeMedia.hasActiveMicrophone(),
            isNativeMicrophoneMuted: () => nativeMedia.isMicrophoneMuted(),
          }),
        syncVoiceFlagsToGateway,
        shouldUseNativeMicrophone,
        startNativeMicrophone,
        isCurrentVoiceSession,
        syncMicFromRoom: (activeRoom, issue) => {
          syncMicFromRoom(activeRoom, issue as VoiceMicIssue | null | undefined)
        },
        syncRoomParticipants,
        syncLocalSpeakingTrack,
        activeChannelAudioBitrateKbps,
        applyMicProcessing,
        getSelfDeafened: () => deafenedRef.current,
      },
    }
  }, [
    abortJoinAttempt,
    activeChannelAudioBitrateKbps,
    applyMicProcessing,
    attachAudio,
    auth.gatewayState,
    auth.session?.token,
    auth.user?._id,
    cleanupAudio,
    disconnectNativeMediaForHandoff,
    finishLocalVoiceSetup,
    getActiveVoiceOperationId,
    getActiveVoiceSession,
    isCurrentVoiceSession,
    publishScreenViewerLeaves,
    readCurrentVoiceFlags,
    resetVoiceState,
    restoreVoicePreferences,
    startNativeMicrophone,
    syncLocalSpeakingTrack,
    syncMicFromRoom,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeState((state) => {
      if (state !== 'connected') return
      voiceIntentExecutorRef.current.reconcileWithServer('gateway_connected')

      const activeChannelId = channelIdRef.current
      if (status !== 'connected' || !activeChannelId) return
      const { selfMute, selfDeaf } = readCurrentVoiceFlags()
      syncVoiceFlagsToGateway(
        activeChannelId,
        selfMute,
        selfDeaf,
      )
    })
    return () => {
      void unsubscribe()
    }
  }, [readCurrentVoiceFlags, status, syncVoiceFlagsToGateway])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      const action = voiceIntentActionFromGatewayEvent(
        event,
        auth.user?._id ?? null,
      )
      if (action?.type === 'commit') {
        voiceIntentExecutorRef.current.observeCommit(action.operationId, action.channelId)
      } else if (action?.type === 'leave_observed') {
        voiceIntentExecutorRef.current.observeLeave(action.operationId)
      }
    })
    return () => {
      unsubscribe()
    }
  }, [auth.user?._id])

  const join = useCallback(
    async (targetChannelId: string) => {
      const token = auth.session?.token
      if (!token) {
        toast.error('Нет сессии')
        return false
      }

      if (
        channelId === targetChannelId &&
        status === 'connected' &&
        roomRef.current != null
      ) {
        return true
      }

      const now = Date.now()
      if (voiceTransitionRateLimitRef.current.isBlocked(now)) {
        return false
      }

      const targetChannel = syncStore.getState().channels[targetChannelId]
      if (!canJoinVoiceChannel(targetChannel)) {
        toast.error('Голос недоступен в этом канале')
        return false
      }

      const hasPreviousSession = Boolean(getActiveVoiceSession())
      const reason: VoiceJoinReason = hasPreviousSession
        ? 'switch'
        : targetChannel.channel_type === 'DirectMessage' ||
            targetChannel.channel_type === 'Group'
          ? 'dm_answer'
          : 'manual_join'

      voiceTransitionRateLimitRef.current.record(now)
      voiceIntentExecutorRef.current.intent(targetChannelId, reason)
      return true
    },
    [
      auth.session?.token,
      channelId,
      getActiveVoiceSession,
      getActiveVoiceOperationId,
      status,
    ],
  )
  joinRef.current = join

  const {
    stopNativeScreenShare,
    handleNativeScreenPublicationLost,
    toggleScreenShare,
  } = useVoiceScreenShare({
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
    getUserId: () => auth.user?._id ?? null,
    isCurrentVoiceSession,
    activeChannelAudioBitrateKbps,
    refreshNativeLiveKitCredentials,
    setScreenShareDebugRun,
    setScreenShareStarting,
    setScreenShareEnabled,
    dispatchNativeMedia,
    syncRoomParticipants,
  })
  stopNativeScreenShareRef.current = stopNativeScreenShare

  useEffect(() => {
    nativeScreenPublicationLostRef.current = handleNativeScreenPublicationLost
    return () => {
      if (
        nativeScreenPublicationLostRef.current === handleNativeScreenPublicationLost
      ) {
        nativeScreenPublicationLostRef.current = null
      }
    }
  }, [handleNativeScreenPublicationLost])

  useEffect(() => {
    if (status === 'connected') {
      applyRemoteAudio(deafened)
      syncLocalSpeakingTrack()
    }
  }, [applyRemoteAudio, deafened, status, syncLocalSpeakingTrack])

  useEffect(() => {
    if (status !== 'connected' || !shouldUseNativeMicrophone()) {
      return
    }

    const desktop = getSyrnikeDesktop()
    if (!desktop) return

    return desktop.media.onMicrophoneMetrics((metrics) => {
      const active = nativeMedia.getMicrophoneSession()
      if (!active || metrics.sessionId !== active.sessionId) return
      setSelfSpeaking(
        metrics.open &&
          !nativeMedia.isMicrophoneMuted() &&
          !deafenedRef.current &&
          !selfMonitoringRef.current.active,
      )
    })
  }, [nativeMedia, setSelfSpeaking, status])

  useEffect(() => {
    if (status !== 'connected') return

    voiceIntentExecutorRef.current.reconcileWithServer('health_tick_initial')
    const interval = window.setInterval(
      () => voiceIntentExecutorRef.current.reconcileWithServer('health_tick'),
      VOICE_RECOVERY_HEALTH_INTERVAL_MS,
    )
    return () => {
      window.clearInterval(interval)
    }
  }, [status])

  useEffect(() => {
    return voiceListenerStore.subscribe(() => {
      if (status === 'connected') {
        applyRemoteAudio(deafenedRef.current)
      }
    })
  }, [status])

  useEffect(() => {
    return voicePreferenceStore.subscribe(() => {
      const previous = lastVoicePreferencesRef.current
      const next = readVoicePreferences()
      lastVoicePreferencesRef.current = next
      if (status !== 'connected') return
      const room = roomRef.current
      if (!room) return
      const effects = voicePreferenceEffectFlags(previous, next)
      if (effects.devicesChanged) {
        void applyVoiceDevices(room).then(() => {
          if (shouldUseNativeMicrophone()) {
            configureNativeMicrophoneSession(
              nativeMedia.getMicrophoneSession(),
              next,
            )
          } else {
            void refreshMicProcessing(room).then(() => {
              syncLocalSpeakingTrack(room)
            })
          }
        })
      } else if (effects.remoteAudioChanged) {
        applyRemoteAudio(deafenedRef.current)
      }
      if (effects.micProcessingChanged) {
        if (shouldUseNativeMicrophone()) {
          configureNativeMicrophoneSession(
            nativeMedia.getMicrophoneSession(),
            next,
          )
        } else {
          void refreshMicProcessing(room).then(() => {
            syncLocalSpeakingTrack(room)
          })
        }
      }
    })
  }, [
    applyVoiceDevices,
    nativeMedia,
    startNativeMicrophone,
    status,
    syncLocalSpeakingTrack,
  ])

  useEffect(() => {
    return () => {
      void voiceIntentExecutorRef.current.disconnectLocalSession()
    }
  }, [])

  useEffect(() => {
    void resolveVoiceNodeName()
  }, [])

  const stageMediaItemsForUi = useMemo(
    () =>
      withConnectingLocalAvatarItem(stageMediaItems, {
        connecting: status === 'connecting' && channelId != null,
        localUserId: auth.user?._id,
        filters: stageMediaFilters,
      }),
    [
      auth.user?._id,
      channelId,
      stageMediaFilters,
      stageMediaItems,
      status,
    ],
  )

  const getNativeMicrophonePreviewTrack = useCallback(
    () => {
      return null
    },
    [],
  )

  const mediaAvailability = useMemo(
    () =>
      buildVoiceMediaAvailabilityState({
        inputDevices,
        videoDevices,
        micIssue,
      }),
    [inputDevices, micIssue, videoDevices],
  )
  const sessionValue = useMemo<VoiceSessionContextValue>(
    () => ({
      channelId,
      status,
      connectionPhase,
      localVoiceReady,
      micEnabled,
      micPublishing,
      deafened,
      participantCount,
      speakingUserIds,
      join,
      leave,
      toggleMic,
      toggleDeafen,
    }),
    [
      channelId,
      connectionPhase,
      deafened,
      join,
      leave,
      localVoiceReady,
      micEnabled,
      micPublishing,
      participantCount,
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
      cameraEnabled,
      screenShareEnabled: screenShareEnabledForUi,
      screenShareStarting: screenShareStartingForUi,
      toggleCamera,
      toggleScreenShare,
      setSelfMonitoringActive,
      getNativeMicrophonePreviewTrack,
    }),
    [
      cameraEnabled,
      getNativeMicrophonePreviewTrack,
      mediaAvailability,
      micIssue,
      screenShareEnabledForUi,
      screenShareStartingForUi,
      setSelfMonitoringActive,
      toggleCamera,
      toggleScreenShare,
    ],
  )

  const stageValue = useMemo<VoiceStageContextValue>(
    () => ({
      stageMediaItems: stageMediaItemsForUi,
      focusedMediaId,
      setFocusedMediaId,
      stageFocusNonce,
      watchParticipantScreenShare,
      stageMediaFilters,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFullscreen,
      toggleStageFullscreen,
    }),
    [
      focusedMediaId,
      setFocusedMediaId,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFocusNonce,
      stageFullscreen,
      stageMediaFilters,
      stageMediaItemsForUi,
      toggleStageFullscreen,
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
      setRtcDebugEnabled,
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
            <NativeScreenShareCoordinator />
            <DesktopScreenSharePicker />
          </VoiceTelemetryContext.Provider>
        </VoiceStageContext.Provider>
      </VoiceMediaContext.Provider>
    </VoiceSessionContext.Provider>
  )
}
