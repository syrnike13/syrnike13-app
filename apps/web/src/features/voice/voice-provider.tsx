import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
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
import {
  readStageMediaFilters,
  writeStageMediaFilters,
} from '#/features/voice/voice-stage-filters'
import {
  isLiveKitTokenFailure,
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
  patchLocalVoiceCamera,
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
  removeLocalUserFromAllVoiceChannels,
} from '#/features/voice/voice-participant-sync'
import {
  localParticipantVoiceFlags,
  participantMicPublishing,
} from '#/features/voice/voice-participant-media'
import {
  appendVoicePingSample,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { measureVoicePingMs } from '#/features/voice/voice-ping'
import {
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  type RtcDebugSnapshot,
  type RtcDebugStageMediaItem,
} from '#/features/voice/voice-rtc-debug'
import {
  type ScreenShareCaptureLimits,
  voiceMicPublishOptions,
} from '#/features/voice/voice-capture'
import { resolveScreenShareCaptureLimits } from '#/features/voice/voice-screen-share-limits'
import {
  handleNativeScreenPublicationLost as handleNativeScreenPublicationLostFromDeps,
  rtcDebugScreenSlice,
  startBrowserScreenShare as startBrowserScreenShareFromDeps,
  startLocalScreenShare as startLocalScreenShareFromDeps,
  stopNativeScreenShare as stopNativeScreenShareFromDeps,
  type NativeScreenPublicationLoss,
  type NativeScreenPublicationLossHandler,
} from '#/features/voice/voice-screen-share'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { shouldUseNativeScreenShare } from '#/features/voice/native-screen-share-mode'
import { createVoiceOperationId } from '#/features/voice/voice-operation'
import {
  nativeOrBrowserPublisherHealthy,
} from '#/features/voice/voice-recovery-runner'
import {
  createInitialNativeMediaState,
  isNativeScreenPublished,
  isNativeScreenStarting,
  type NativeMediaAction,
  nativeMediaReducer,
} from '#/features/voice/native-media-coordinator'
import {
  findNativeScreenPublication,
  waitForNativeScreenPublication,
} from '#/features/voice/voice-publication-observer'
import {
  publishNativeScreenShare,
  type NativeScreenShareSession,
} from '#/features/voice/native-screen-share-publish'
import {
  configureNativeMicrophoneSession,
  publishNativeMicrophone,
  shouldRestartNativeMicrophonePublisher,
  shouldUseNativeMicrophone,
  type NativeMicrophoneSession,
} from '#/features/voice/native-microphone-publish'
import {
  disconnectNativeMediaForHandoff as disconnectNativeMediaForHandoffFromDeps,
  refreshNativeLiveKitCredentials as refreshNativeLiveKitCredentialsFromDeps,
  resetNativeMediaState,
  setNativeMicrophoneMuted as setNativeMicrophoneMutedFromDeps,
  startNativeMicrophone as startNativeMicrophoneFromDeps,
} from '#/features/voice/voice-native-media'
import { baseVoiceIdentity } from '#/features/voice/native-voice-identity'
import { NativeScreenShareCoordinator } from '#/features/voice/native-screen-share-coordinator'
import {
  clearNativePickerSelection,
  rejectNativePickerSelection,
  waitForNativePickerSelection,
} from '#/features/voice/native-screen-share-session'
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
import { isVoiceConnectedInChannel } from '#/features/voice/voice-watch-screen-share'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  effectiveVoiceJoinPreferences,
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import {
  createConnectingLocalVoiceState,
  isVoiceLocalUserId,
  withConnectingLocalAvatarItem,
} from '#/features/voice/voice-connecting-preview'
import {
  type StageMediaFilters,
  stageMediaItemId,
} from '#/features/voice/voice-stage-media'
import {
  applyRemoteScreenParticipantSubscription as applyRemoteScreenParticipantSubscriptionToRoom,
  syncRoomParticipants as syncRoomParticipantsForRoom,
  syncStageMediaItems as syncStageMediaItemsForRoom,
} from '#/features/voice/voice-stage-media-sync'
import {
  resolveStageScreenSubscriptionTarget,
  setRemoteScreenWatchIntent,
  setStageScreenSubscription,
  stageScreenMediaUserId,
} from '#/features/voice/voice-stage-subscription'
import {
  SCREEN_VIEWER_SOUND_TOPIC,
  createScreenViewerSoundPayload,
  screenViewerSoundEventFromData,
} from '#/features/voice/voice-screen-viewer-sounds'
import { runVoiceRequest } from '#/features/voice/voice-request-gate'
import { createVoiceTransitionRateLimiter } from '#/features/voice/voice-transition-rate-limit'
import { channelAudioBitrateKbps } from '#/lib/channel-audio-bitrate'
import { playUiSound } from '#/features/sounds/sound-player'
import {
  VoiceContext,
  type VoiceContextValue,
  type VoiceStageMediaItem,
} from '#/features/voice/voice-context'

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
  const nativeMicrophoneRef = useRef<NativeMicrophoneSession | null>(null)
  const nativeMicrophoneStartRef = useRef<Promise<boolean> | null>(null)
  const nativeMicrophoneStartGenerationRef = useRef(0)
  const nativeMicrophoneMutedRef = useRef(false)
  const liveKitCredentialsRef = useRef<LiveKitNativeCredentials | null>(null)
  const watchedRemoteScreenIdsRef = useRef<Set<string>>(new Set())
  const pendingScreenWatchIdsRef = useRef<Set<string>>(new Set())
  const screenShareDebugUntilRef = useRef(0)
  const lastStageSyncDebugKeyRef = useRef<string | null>(null)
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
      getToken: () => voiceJoinDepsRef.current.getToken(),
      getLocalUserId: () => voiceJoinDepsRef.current.getLocalUserId(),
      isJoinBlocked: () => voiceJoinDepsRef.current.isJoinBlocked(),
      isCurrentJoinOperation: (operationId) =>
        voiceJoinDepsRef.current.isCurrentJoinOperation?.(operationId) ?? true,
      beginConnecting: (channelId, preview) =>
        voiceJoinDepsRef.current.beginConnecting(channelId, preview),
      attachRoomHandlers: (room) =>
        voiceJoinDepsRef.current.attachRoomHandlers(room),
      setLiveKitCredentials: (credentials) =>
        voiceJoinDepsRef.current.setLiveKitCredentials(credentials),
      setConnectionPhase: (phase) =>
        voiceJoinDepsRef.current.setConnectionPhase(phase),
      onRoomConnected: (room, channelId) =>
        voiceJoinDepsRef.current.onRoomConnected(room, channelId),
      onJoinSuccess: () => voiceJoinDepsRef.current.onJoinSuccess(),
      abortJoin: () => voiceJoinDepsRef.current.abortJoin(),
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
      getUserId: () => undefined,
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
      getToken: () => voiceIntentExecutorDepsRef.current.getToken(),
      getLocalUserId: () => voiceIntentExecutorDepsRef.current.getLocalUserId(),
      isJoinBlocked: () => voiceIntentExecutorDepsRef.current.isJoinBlocked(),
      getActiveSession: () =>
        voiceIntentExecutorDepsRef.current.getActiveSession(),
      performVoiceJoin: (channelId, options) =>
        voiceIntentExecutorDepsRef.current.performVoiceJoin(channelId, options),
      requestVoiceLeave: () =>
        voiceIntentExecutorDepsRef.current.requestVoiceLeave(),
      shouldKeepRejoining: (channelId) =>
        voiceIntentExecutorDepsRef.current.shouldKeepRejoining(channelId),
      attachRoomHandlers: (room) =>
        voiceIntentExecutorDepsRef.current.attachRoomHandlers(room),
      onRoomConnected: (room, channelId) =>
        voiceIntentExecutorDepsRef.current.onRoomConnected(room, channelId),
      onAbort: () => voiceIntentExecutorDepsRef.current.onAbort(),
      beginVisualTransition: (channelId) =>
        voiceIntentExecutorDepsRef.current.beginVisualTransition(channelId),
      clearVisualPresence: (channelId) =>
        voiceIntentExecutorDepsRef.current.clearVisualPresence(channelId),
      completeTerminalLeave: (session) =>
        voiceIntentExecutorDepsRef.current.completeTerminalLeave(session),
      disconnectLocalSession: (session) =>
        voiceIntentExecutorDepsRef.current.disconnectLocalSession(session),
      disconnectMoveSource: (session) =>
        voiceIntentExecutorDepsRef.current.disconnectMoveSource(session),
      onRoomChanged: (room) =>
        voiceIntentExecutorDepsRef.current.onRoomChanged(room),
      setLiveKitCredentials: (credentials) =>
        voiceIntentExecutorDepsRef.current.setLiveKitCredentials(credentials),
      setConnectionPhase: (phase) =>
        voiceIntentExecutorDepsRef.current.setConnectionPhase(phase),
      recovery: {
        getGatewayConnected: () =>
          voiceIntentExecutorDepsRef.current.recovery.getGatewayConnected(),
        getActiveChannelId: () =>
          voiceIntentExecutorDepsRef.current.recovery.getActiveChannelId(),
        getUserId: () => voiceIntentExecutorDepsRef.current.recovery.getUserId(),
        getStatus: () => voiceIntentExecutorDepsRef.current.recovery.getStatus(),
        getVoiceParticipants: () =>
          voiceIntentExecutorDepsRef.current.recovery.getVoiceParticipants(),
        canTrustServerState: (trigger) =>
          voiceIntentExecutorDepsRef.current.recovery.canTrustServerState(
            trigger,
          ),
        readCurrentVoiceFlags: (room) =>
          voiceIntentExecutorDepsRef.current.recovery.readCurrentVoiceFlags(room),
        readVoicePreferences: () =>
          voiceIntentExecutorDepsRef.current.recovery.readVoicePreferences(),
        isSelfMonitoringActive: () =>
          voiceIntentExecutorDepsRef.current.recovery.isSelfMonitoringActive(),
        isPublisherHealthy: (room) =>
          voiceIntentExecutorDepsRef.current.recovery.isPublisherHealthy(room),
        syncVoiceFlagsToGateway: (channelId, selfMute, selfDeaf) =>
          voiceIntentExecutorDepsRef.current.recovery.syncVoiceFlagsToGateway(
            channelId,
            selfMute,
            selfDeaf,
          ),
        shouldUseNativeMicrophone: () =>
          voiceIntentExecutorDepsRef.current.recovery.shouldUseNativeMicrophone(),
        startNativeMicrophone: (room, muted) =>
          voiceIntentExecutorDepsRef.current.recovery.startNativeMicrophone(
            room,
            muted,
          ),
        isCurrentVoiceSession: (room, targetChannelId) =>
          voiceIntentExecutorDepsRef.current.recovery.isCurrentVoiceSession(
            room,
            targetChannelId,
          ),
        syncMicFromRoom: (room, issue) =>
          voiceIntentExecutorDepsRef.current.recovery.syncMicFromRoom(
            room,
            issue,
          ),
        syncRoomParticipants: () =>
          voiceIntentExecutorDepsRef.current.recovery.syncRoomParticipants(),
        syncLocalSpeakingTrack: (room) =>
          voiceIntentExecutorDepsRef.current.recovery.syncLocalSpeakingTrack(room),
        activeChannelAudioBitrateKbps: () =>
          voiceIntentExecutorDepsRef.current.recovery.activeChannelAudioBitrateKbps(),
        applyMicProcessing: (participant) =>
          voiceIntentExecutorDepsRef.current.recovery.applyMicProcessing(
            participant,
          ),
        getSelfDeafened: () =>
          voiceIntentExecutorDepsRef.current.recovery.getSelfDeafened(),
      },
    }),
  )
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
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
  const [voicePingMs, setVoicePingMs] = useState<number | null>(null)
  const [voicePingHistory, setVoicePingHistory] = useState<VoicePingSample[]>(
    [],
  )
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const [screenShareDebugRun, setScreenShareDebugRun] = useState(0)
  const [stageMediaItems, setStageMediaItemsState] = useState<
    VoiceStageMediaItem[]
  >([])
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [screenShareEnabled, setScreenShareEnabled] = useState(false)
  const [screenShareStarting, setScreenShareStarting] = useState(false)
  const screenShareStartingRef = useRef(false)
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
  const [focusedMediaId, setFocusedMediaId] = useState<string | null>(null)
  const [stageFocusNonce, setStageFocusNonce] = useState(0)
  const [stageFullscreen, setStageFullscreen] = useState(false)

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

  const setStageMediaItems = useCallback((items: VoiceStageMediaItem[]) => {
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
        currentUserId: auth.user?._id,
        localParticipantIdentity: roomRef.current?.localParticipant.identity,
        watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
        pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
      })
    },
    [auth.user?._id],
  )

  const syncStageMediaItems = useCallback(
    (room: Room) => {
      syncStageMediaItemsForRoom({
        room,
        nativeMediaState: nativeMediaStateRef.current,
        stoppedNativeScreenIdentity: stoppedNativeScreenIdentityRef.current,
        authUserId: auth.user?._id,
        stageMediaFilters,
        watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
        pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
        lastStageSyncDebugKey: lastStageSyncDebugKeyRef,
        applyRemoteScreenParticipantSubscription,
        setStageMediaItems,
        onNativeScreenPublicationLost: (loss) => {
          nativeScreenPublicationLostRef.current?.(loss)
        },
        logStageSyncDebug: logVoiceDebugAgent,
      })
    },
    [
      applyRemoteScreenParticipantSubscription,
      auth.user?._id,
      setStageMediaItems,
      stageMediaFilters,
    ],
  )

  const syncRoomParticipants = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    syncRoomParticipantsForRoom({
      room,
      nativeMediaState: nativeMediaStateRef.current,
      activeChannelId: channelIdRef.current,
      userId: auth.user?._id,
      setCameraEnabled,
      setScreenShareEnabled,
      patchLocalVoiceCamera,
      syncStageMediaItems,
    })
  }, [auth.user?._id, syncStageMediaItems])

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
        hasNativeMicrophone: Boolean(nativeMicrophoneRef.current),
        nativeMicrophoneMuted: nativeMicrophoneMutedRef.current,
        activeChannelId: channelIdRef.current,
        userId: auth.user?._id,
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
    [auth.user?._id, setCurrentMicIssue],
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
      hasNativeMicrophone: Boolean(nativeMicrophoneRef.current),
      nativeMicrophoneMuted: nativeMicrophoneMutedRef.current,
      fallbackMicPublishing: micPublishingRef.current,
    })
  }, [])

  const refreshNativeLiveKitCredentials = useCallback(
    async (
      mediaKind: LiveKitNativeMediaKind,
      force = false,
    ): Promise<LiveKitNativePublisherCredentials> => {
      return refreshNativeLiveKitCredentialsFromDeps({
        liveKitCredentialsRef,
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
    [auth.gatewayState, readCurrentVoiceFlags],
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
    resetNativeMediaState({
      nativeMicrophoneStartGenerationRef,
      nativeMicrophoneStartRef,
      screenShareStartGenerationRef,
      screenShareStartingRef,
      pendingScreenShareStartRef,
      nativeMicrophoneRef,
      nativeMicrophoneMutedRef,
      selfMonitoringRef,
      nativeScreenShareRef,
      stoppedNativeScreenIdentityRef,
      nativeScreenPublicationLossKeyRef,
      watchedRemoteScreenIdsRef,
      pendingScreenWatchIdsRef,
      resetNativeMediaEngineStats: () => nativeMediaEngineStatsStore.reset(),
      getDesktop: getSyrnikeDesktop,
      clearWatchedScreenIds: true,
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
    setVoicePingMs(null)
    setVoicePingHistory([])
    rtcDebugSnapshotRef.current = null
    setRtcDebugSnapshot(null)
    setRtcDebugHistory([])
    setStageMediaItems([])
    setCameraEnabled(false)
    setScreenShareEnabled(false)
    setScreenShareStarting(false)
    dispatchNativeMedia({ type: 'reset' })
    setFocusedMediaId(null)
    setStageFullscreen(false)
  }, [
    restoreVoicePreferences,
    setCurrentMicIssue,
    setStageMediaItems,
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
      await setNativeMicrophoneMutedFromDeps({
        nativeMicrophoneRef,
        nativeMicrophoneMutedRef,
        setMicPublishing,
        setSelfSpeaking,
        syncRoomParticipants,
      }, muted)
    },
    [setSelfSpeaking, syncRoomParticipants],
  )

  const startNativeMicrophone = useCallback(
    async (room: Room, muted = false) => {
      return startNativeMicrophoneFromDeps({
        room,
        muted,
        getTargetChannelId: () => channelIdRef.current,
        isCurrentVoiceSession,
        nativeMicrophoneRef,
        nativeMicrophoneStartRef,
        nativeMicrophoneStartGenerationRef,
        nativeMicrophoneMutedRef,
        setNativeMicrophoneMuted,
        publishNativeMicrophone,
        refreshNativeLiveKitCredentials,
        activeChannelAudioBitrateKbps,
        createRequestId: () => crypto.randomUUID(),
        onNativeMicrophoneStopped: (sessionId) => {
          if (nativeMicrophoneRef.current?.sessionId !== sessionId) return
          nativeMicrophoneRef.current = null
          nativeMicrophoneMutedRef.current = false
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
        setNativeMicrophoneSession: (session) => {
          nativeMicrophoneRef.current = session
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
      readCurrentVoiceFlags,
      setSelfSpeaking,
      setNativeMicrophoneMuted,
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
        getUserId: () => auth.user?._id,
        hasNativeMicrophonePublishing: () =>
          Boolean(nativeMicrophoneRef.current && !nativeMicrophoneMutedRef.current),
        patchLocalVoiceDeafen,
        syncVoiceFlagsToGateway,
        setLocalVoiceReady,
      })
    },
    [
      applyVoiceDevices,
      auth.user?._id,
      isCurrentVoiceSession,
      setCurrentMicIssue,
      startNativeMicrophone,
      activeChannelAudioBitrateKbps,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const setSelfMonitoringActive = useCallback(
    (active: boolean) => {
      const room = roomRef.current
      const activeChannelId = channelIdRef.current
      const userId = auth.user?._id
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
        ? Boolean(nativeMicrophoneRef.current && !nativeMicrophoneMutedRef.current)
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
          void applyMicProcessing(room.localParticipant).then(() => {
            syncLocalSpeakingTrack(room)
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
      auth.user?._id,
      activeChannelAudioBitrateKbps,
      isCurrentVoiceSession,
      setCurrentMicIssue,
      setSelfSpeaking,
      startNativeMicrophone,
      status,
      setNativeMicrophoneMuted,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const disconnectNativeMediaForHandoff = useCallback(() => {
    disconnectNativeMediaForHandoffFromDeps({
      nativeMicrophoneStartGenerationRef,
      nativeMicrophoneStartRef,
      screenShareStartGenerationRef,
      screenShareStartingRef,
      pendingScreenShareStartRef,
      nativeMicrophoneRef,
      nativeMicrophoneMutedRef,
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
  }, [setSelfSpeaking])

  const attachAudio = useCallback(
    (room: Room) => {
      attachRoomAudio(room, {
        currentUserId: auth.user?._id,
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
        liveKitCredentialsRef.current = credentials
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
        liveKitCredentialsRef.current = credentials
      },
      setConnectionPhase,
      recovery: {
        getGatewayConnected: () => auth.gatewayState === 'connected',
        getActiveChannelId: () => channelIdRef.current,
        getUserId: () => auth.user?._id,
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
            hasActiveNativeMicrophone: () => Boolean(nativeMicrophoneRef.current),
            isNativeMicrophoneMuted: () => nativeMicrophoneMutedRef.current,
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
      const action = voiceIntentActionFromGatewayEvent(event, auth.user?._id)
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

  useEffect(() => {
    const room = roomRef.current
    if (room) syncStageMediaItems(room)
  }, [stageMediaFilters, syncStageMediaItems])

  useEffect(() => {
    setFocusedMediaId((current) =>
      current && stageMediaItems.some((item) => item.id === current && item.live)
        ? current
        : null,
    )
  }, [stageMediaItems])

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
  }, [])

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
    [stopNativeScreenShare, syncRoomParticipants],
  )

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

  const requestStageMediaFocus = useCallback((mediaId: string) => {
    setFocusedMediaId(mediaId)
    setStageFocusNonce((current) => current + 1)
  }, [])

  const watchParticipantScreenShare = useCallback(
    async (targetChannelId: string, userId: string) => {
      const mediaId = stageMediaItemId(userId, 'screen')
      const localUserId = auth.user?._id
      const isLocal = isVoiceLocalUserId(userId, localUserId)
      const wasWatching = watchedRemoteScreenIdsRef.current.has(mediaId)

      if (!isLocal) {
        pendingScreenWatchIdsRef.current.add(mediaId)
        watchedRemoteScreenIdsRef.current.add(mediaId)
      }

      if (!isVoiceConnectedInChannel({ channelId, status }, targetChannelId)) {
        await join(targetChannelId)
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
      auth.user?._id,
      channelId,
      join,
      publishScreenViewerSound,
      requestStageMediaFocus,
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
      if (auth.user?._id) currentUserIds.add(auth.user._id)
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
      auth.user?._id,
      publishScreenViewerSound,
      stopNativeScreenShare,
      syncRoomParticipants,
      syncStageMediaItems,
    ],
  )

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
  }, [syncRoomParticipants])

  const startBrowserScreenShare = useCallback(
    async (
      room: Room,
      quality: ScreenShareQualityName,
      withAudio: boolean,
      limits?: ScreenShareCaptureLimits,
    ) => {
      await startBrowserScreenShareFromDeps({
        room,
        quality,
        withAudio,
        limits,
        activeChannelAudioBitrateKbps,
        setScreenShareEnabled,
        syncRoomParticipants,
        playUiSound,
        setChromiumNativeMediaStats: () => {
          nativeMediaEngineStatsStore.setChromium()
        },
      })
    },
    [activeChannelAudioBitrateKbps, syncRoomParticipants],
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
        getUserId: () => auth.user?._id,
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
        startBrowserScreenShare,
        refreshNativeLiveKitCredentials,
        activeChannelAudioBitrateKbps,
        logVoiceDebugAgent,
        toastError: (message) => toast.error(message),
        playUiSound,
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
      refreshNativeLiveKitCredentials,
      getActiveVoiceOperationId,
      activeChannelAudioBitrateKbps,
      auth.user?._id,
      isCurrentVoiceSession,
      startBrowserScreenShare,
      stopNativeScreenShare,
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
  }, [localVoiceReady, startLocalScreenShare, status])

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
          .then(() => {
            setScreenShareEnabled(false)
            playUiSound('screen_share.stopped')
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
          playUiSound('screen_share.stopped')
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

    const prefs = readVoicePreferences()
    void startLocalScreenShare(prefs.screenShareQuality, prefs.screenShareAudio)
  }, [
    screenShareStarting,
    startLocalScreenShare,
    stopNativeScreenShare,
    syncRoomParticipants,
  ])

  const toggleStageFullscreen = useCallback(() => {
    setStageFullscreen((value) => !value)
  }, [])

  const toggleMic = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
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
              void applyMicProcessing(room.localParticipant).then(() => {
                syncLocalSpeakingTrack(room)
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
    auth.user?._id,
    activeChannelAudioBitrateKbps,
    isCurrentVoiceSession,
    setCurrentMicIssue,
    setSelfSpeaking,
    readCurrentVoiceFlags,
    startNativeMicrophone,
    status,
    syncMicFromRoom,
    syncLocalSpeakingTrack,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
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
    auth.user?._id,
    isCurrentVoiceSession,
    setCurrentMicIssue,
    setSelfSpeaking,
    startNativeMicrophone,
    status,
    syncLocalSpeakingTrack,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

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
      const active = nativeMicrophoneRef.current
      if (!active || metrics.sessionId !== active.sessionId) return
      setSelfSpeaking(
        metrics.open &&
          !nativeMicrophoneMutedRef.current &&
          !deafenedRef.current &&
          !selfMonitoringRef.current.active,
      )
    })
  }, [setSelfSpeaking, status])

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
            configureNativeMicrophoneSession(nativeMicrophoneRef.current, next)
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
          configureNativeMicrophoneSession(nativeMicrophoneRef.current, next)
        } else {
          void refreshMicProcessing(room).then(() => {
            syncLocalSpeakingTrack(room)
          })
        }
      }
    })
  }, [applyVoiceDevices, startNativeMicrophone, status, syncLocalSpeakingTrack])

  useEffect(() => {
    return () => {
      void voiceIntentExecutorRef.current.disconnectLocalSession()
    }
  }, [])

  useEffect(() => {
    void resolveVoiceNodeName()
  }, [])

  useEffect(() => {
    if (status !== 'connected') {
      setVoicePingMs(null)
      setVoicePingHistory([])
      return
    }

    const room = roomRef.current
    if (!room) return

    let active = true

    async function samplePing() {
      const ping = await measureVoicePingMs(room!)
      if (!active) return
      setVoicePingMs(ping)
      if (ping != null) {
        setVoicePingHistory((history) =>
          appendVoicePingSample(history, {
            timestamp: Date.now(),
            ms: ping,
          }),
        )
      }
    }

    void samplePing()
    const interval = window.setInterval(() => void samplePing(), 2000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [status])

  useEffect(() => {
    if (status !== 'connected') {
      rtcDebugSnapshotRef.current = null
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    if (!rtcDebugEnabled) return

    const room = roomRef.current
    if (!room) return

    let active = true

    async function sampleRtcDebug() {
      try {
        const current = await collectVoiceRtcDebugSnapshot(
          room!,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return

        const previous = rtcDebugSnapshotRef.current
        const snapshot: RtcDebugSnapshot = previous
          ? {
              ...current,
              rates: deriveRtcRates(previous, current),
            }
          : current

        rtcDebugSnapshotRef.current = snapshot
        setRtcDebugSnapshot(snapshot)
        setRtcDebugHistory((history) =>
          appendRtcDebugSample(history, snapshot),
        )
      } catch {
        if (!active) return
        rtcDebugSnapshotRef.current = null
        setRtcDebugSnapshot(null)
      }
    }

    void sampleRtcDebug()
    const interval = window.setInterval(() => void sampleRtcDebug(), 1000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [rtcDebugEnabled, status])

  useEffect(() => {
    if (status !== 'connected') return
    if (screenShareDebugRun === 0) return

    const room = roomRef.current
    if (!room) return

    let active = true
    let interval: number | null = null

    async function sampleScreenShareDebug() {
      if (Date.now() > screenShareDebugUntilRef.current) {
        if (interval != null) {
          window.clearInterval(interval)
          interval = null
        }
        return
      }
      try {
        const snapshot = await collectVoiceRtcDebugSnapshot(
          room!,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample',
          ...rtcDebugScreenSlice(snapshot),
        })
      } catch (error) {
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void sampleScreenShareDebug()
    interval = window.setInterval(
      () => void sampleScreenShareDebug(),
      1000,
    )

    return () => {
      active = false
      if (interval != null) {
        window.clearInterval(interval)
      }
    }
  }, [screenShareDebugRun, status])

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
  const screenShareEnabledForUi =
    screenShareEnabled || isNativeScreenPublished(nativeMediaState)
  const screenShareStartingForUi =
    screenShareStarting || isNativeScreenStarting(nativeMediaState)

  const value = useMemo<VoiceContextValue>(
    () => ({
      channelId,
      status,
      connectionPhase,
      localVoiceReady,
      micEnabled,
      micPublishing,
      micIssue,
      mediaAvailability,
      deafened,
      participantCount,
      speakingUserIds,
      voicePingMs,
      voicePingHistory,
      rtcDebugEnabled,
      setRtcDebugEnabled,
      rtcDebugSnapshot,
      rtcDebugHistory,
      cameraEnabled,
      screenShareEnabled: screenShareEnabledForUi,
      screenShareStarting: screenShareStartingForUi,
      stageMediaItems: stageMediaItemsForUi,
      focusedMediaId,
      stageFocusNonce,
      join,
      leave,
      setFocusedMediaId,
      watchParticipantScreenShare,
      stageMediaFilters,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFullscreen,
      toggleMic,
      toggleStageFullscreen,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      setSelfMonitoringActive,
      getNativeMicrophonePreviewTrack,
    }),
    [
      cameraEnabled,
      channelId,
      connectionPhase,
      deafened,
      focusedMediaId,
      stageFocusNonce,
      join,
      leave,
      watchParticipantScreenShare,
      localVoiceReady,
      micEnabled,
      micIssue,
      mediaAvailability,
      micPublishing,
      participantCount,
      screenShareEnabledForUi,
      screenShareStartingForUi,
      speakingUserIds,
      stageMediaFilters,
      stageMediaItemsForUi,
      stageFullscreen,
      status,
      rtcDebugEnabled,
      rtcDebugHistory,
      rtcDebugSnapshot,
      voicePingMs,
      voicePingHistory,
      toggleCamera,
      toggleDeafen,
      toggleMic,
      toggleScreenShare,
      toggleStageFullscreen,
      setSelfMonitoringActive,
      setStageMediaFilters,
      setStageMediaSubscribed,
      getNativeMicrophonePreviewTrack,
    ],
  )

  return (
    <VoiceContext.Provider value={value}>
      {children}
      <NativeScreenShareCoordinator />
      <DesktopScreenSharePicker />
    </VoiceContext.Provider>
  )
}
